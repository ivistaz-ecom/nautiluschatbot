<?php
// backend/services/LLMService.php

require_once __DIR__ . '/DocumentParser.php';
require_once __DIR__ . '/../core/Logger.php';

class LLMService {

    private static function requireSourceAttributor(): void {
        require_once __DIR__ . '/SourceAttributor.php';
    }

    private string $provider;
    private string $apiKey;
    private string $model;
    private array  $cfg;

    public function __construct() {
        $cfg = require __DIR__ . '/../config/config.php';
        $this->cfg      = $cfg['llm'];
        $this->provider = $this->cfg['provider'];
        $this->apiKey   = trim($this->cfg['api_key'] ?? '');
        $this->model    = $this->cfg['model'][$this->provider] ?? 'claude-sonnet-4-6';

        if ($this->apiKey === '') {
            throw new RuntimeException('LLM API key is not configured. Set LLM_API_KEY on the server.');
        }
    }

    /** Quick connectivity check for /health/llm */
    public static function ping(): array {
        $llm = new self();
        $raw = match ($llm->provider) {
            'openai' => $llm->callOpenAI('Reply with exactly: OK'),
            'gemini' => $llm->callGemini('Reply with exactly: OK'),
            default  => $llm->callClaude('Reply with exactly: OK'),
        };
        return ['provider' => $llm->provider, 'model' => $llm->model, 'response' => trim($raw)];
    }

    /**
     * Generate a knowledge-base answer from provided chunks.
     * Returns ['answer' => string, 'sources' => [...], 'confidence' => float, 'answered' => bool]
     */
    public function answer(string $question, array $chunks): array {
        // Remove TOC/index chunks before the LLM call so answers (and citations)
        // are grounded in substantive content, not "Verification .... 49" index rows.
        $substantive = array_values(array_filter(
            $chunks,
            fn($c) => !DocumentParser::isTableOfContentsChunk($c['content'] ?? '')
        ));

        // Prefer empty context over feeding TOC/index pages to the LLM.
        // If detection wiped everything, keep original chunks so answers/sources still work.
        if (empty($substantive)) {
            Logger::info('[llm] TOC filter removed all chunks — using original retrieval set');
            $substantive = $chunks;
        }

        $context = $this->buildContext($substantive);
        $prompt  = $this->buildPrompt($question, $context);

        $raw = match ($this->provider) {
            'openai' => $this->callOpenAI($prompt),
            'gemini' => $this->callGemini($prompt),
            default  => $this->callClaude($prompt),
        };

        // Attribute sources against the same chunk list sent to the LLM.
        return $this->parseResponse($raw, $substantive, $question);
    }

    private function buildContext(array $chunks): string {
        $parts = [];
        foreach ($chunks as $i => $chunk) {
            $fileName = $this->escapePromptValue($chunk['title'] ?? 'Document');
            $pageNumber = $chunk['page_number'] ?? 'unknown';
            $content = $this->stripManualChrome(trim((string) ($chunk['content'] ?? '')));
            if ($content === '') {
                continue;
            }
            $parts[] = "SOURCE {$i}\nFile: {$fileName}\nPage: {$pageNumber}\nText:\n{$content}";
        }
        return implode("\n\n-------------------\n\n", $parts);
    }

    private function buildPrompt(string $question, string $context): string {
        return <<<PROMPT
You are a knowledge assistant for Nautilus Shipping. Answer using ONLY the document excerpts below. Do NOT use external knowledge.

Return STRICT JSON only:
{
  "answer": "concise answer in your own words",
  "usedSources": [0]
}

Rules:
- Answer the EXACT question the user asked (the specific ask), not a nearby related topic.
- Write a clear paraphrase a colleague would understand — 2–5 sentences, or a short numbered/lettered list for steps.
- NEVER paste document chrome: titles like "COMPANY OPERATING MANUAL", "SECTION:", "Page Number", "Page X of Y", "Issue No", revision lines, or header/footer banners.
- NEVER paste long verbatim blocks from the excerpts. Quote at most one short phrase if essential.
- Every sentence must be supported by the excerpts. Ignore excerpts that only share keywords but do not answer the ask.
- Prefer the 1–2 best excerpts. Put only those SOURCE IDs in usedSources (max 2).
- Include codes (e.g. SFT 04) only when they appear in the excerpts and help answer.
- Do not invent source IDs or facts. Do not cite table-of-contents / index rows.
- If none of the excerpts actually answer this exact question, return exactly:
{
  "answer": "I could not find this information in the available documents.",
  "usedSources": []
}
- Never stitch unrelated keyword hits into a fake answer.

--- DOCUMENT EXCERPTS ---
{$context}
--- END EXCERPTS ---

Question: {$question}

Response:
PROMPT;
    }

    /** Remove PDF header/footer chrome that models tend to copy into answers. */
    private function stripManualChrome(string $text): string {
        $lines = preg_split('/\R/u', $text) ?: [];
        $kept = [];
        foreach ($lines as $line) {
            $t = trim($line);
            if ($t === '') {
                continue;
            }
            if ($this->isManualChromeLine($t)) {
                continue;
            }
            // Inline chrome often appears mid-line after OCR collapse.
            $t = preg_replace(
                '/\b(COMPANY|SHIP|SAFETY|HEALTH)\s+OPERATING\s+MANUAL\b[^.]{0,80}/iu',
                '',
                $t
            ) ?? $t;
            $t = preg_replace('/\bPage\s+Number\s*:\s*[^\n.]{0,60}/iu', '', $t) ?? $t;
            $t = preg_replace('/\bPage\s+\d+\s+of\s+\d+\b/iu', '', $t) ?? $t;
            $t = preg_replace('/\bIssue\s+No\s*:?\s*\d+\b/iu', '', $t) ?? $t;
            $t = preg_replace('/\bSECTION\s*:\s*\d+[^\n.]{0,40}/iu', '', $t) ?? $t;
            $t = trim(preg_replace('/\s{2,}/u', ' ', $t) ?? $t);
            if ($t !== '' && !$this->isManualChromeLine($t)) {
                $kept[] = $t;
            }
        }
        return trim(implode("\n", $kept));
    }

    private function isManualChromeLine(string $line): bool {
        $l = mb_strtolower($line);
        if ($l === '') {
            return true;
        }
        if (preg_match('/\b(operating\s+manual|document\s+number|electronic\s+copy|uncontrolled\s+if\s+printed|section\s+revision|revision\s+number|issue\s+no)\b/i', $line)) {
            return true;
        }
        if (preg_match('/^page\s+number\s*:/i', $line)) {
            return true;
        }
        if (preg_match('/^section\s*:\s*\d+/i', $line)) {
            return true;
        }
        if (preg_match('/^page\s+\d+\s+of\s+\d+/i', $line)) {
            return true;
        }
        // Pure banner titles
        if (preg_match('/^(company|ship|safety|health|chemical)\s+.+\s+manual\s*$/i', $line) && mb_strlen($line) < 80) {
            return true;
        }
        return false;
    }

    private function looksLikeRawDump(string $answer): bool {
        if (preg_match('/\b(page\s+number\s*:|page\s+\d+\s+of\s+\d+|operating\s+manual|issue\s+no\s*:|uncontrolled\s+if\s+printed|document\s+number)\b/i', $answer)) {
            return true;
        }
        // Very long answers with little punctuation often mean a pasted chunk.
        $len = mb_strlen($answer);
        if ($len > 900 && substr_count($answer, '.') < 3) {
            return true;
        }
        return false;
    }

    /** Public sanitizer used after LLM + before persist. */
    public function sanitizeAnswer(string $answer): string {
        $text = trim($answer);
        if ($text === '') {
            return '';
        }
        // Drop chrome even when the model pasted it as one long line.
        $text = preg_replace(
            '/\b(COMPANY|SHIP|SAFETY|HEALTH|CHEMICAL)\s+[A-Z][A-Z\s\/\-]{0,40}MANUAL\b/iu',
            '',
            $text
        ) ?? $text;
        $text = preg_replace('/\bSECTION\s*:\s*\d+\s*[-–—]?\s*[A-Z][A-Z\s]{0,40}/iu', '', $text) ?? $text;
        $text = preg_replace('/\bPage\s+Number\s*:\s*[^\n.]{0,80}/iu', '', $text) ?? $text;
        $text = preg_replace('/\bPage\s+\d+\s+of\s+\d+\b/iu', '', $text) ?? $text;
        $text = preg_replace('/\bIssue\s+No\s*:?\s*\d+\b/iu', '', $text) ?? $text;
        $text = preg_replace('/\bCOM\s*:\s*\d+\s*:\s*/iu', '', $text) ?? $text;
        $text = trim(preg_replace('/\s{2,}/u', ' ', $text) ?? $text);
        // If a section code remains at the start ("4.3 DRUG AND ALCOHOL POLICY The Company…"),
        // keep the heading only when followed by prose on the same run — normalize spacing.
        $text = preg_replace('/^(\d+(?:\.\d+){0,3}\s+[A-Z][A-Z0-9\s\/\-&]{3,60})\s+/u', "$1\n\n", $text) ?? $text;
        return trim($text);
    }

    private function escapePromptValue(mixed $value): string {
        $text = (string) $value;
        return str_replace(["\n", "\r"], ' ', $text);
    }

    private function callClaude(string $prompt): string {
        $body = json_encode([
            'model'      => $this->model,
            'max_tokens' => $this->cfg['max_tokens'],
            'messages'   => [['role' => 'user', 'content' => $prompt]],
        ]);

        return $this->httpPost(
            'https://api.anthropic.com/v1/messages',
            $body,
            [
                'x-api-key: ' . $this->apiKey,
                'anthropic-version: 2023-06-01',
                'content-type: application/json',
            ],
            fn($r) => $r['content'][0]['text'] ?? ''
        );
    }

    private function callOpenAI(string $prompt): string {
        $body = json_encode([
            'model'      => $this->model,
            'max_tokens' => $this->cfg['max_tokens'],
            'messages'   => [['role' => 'user', 'content' => $prompt]],
        ]);

        return $this->httpPost(
            'https://api.openai.com/v1/chat/completions',
            $body,
            [
                'Authorization: Bearer ' . $this->apiKey,
                'Content-Type: application/json',
            ],
            fn($r) => $r['choices'][0]['message']['content'] ?? ''
        );
    }

    private function callGemini(string $prompt): string {
        $body = json_encode([
            'contents' => [['parts' => [['text' => $prompt]]]],
        ]);

        $url = "https://generativelanguage.googleapis.com/v1beta/models/{$this->model}:generateContent?key={$this->apiKey}";

        return $this->httpPost(
            $url,
            $body,
            ['Content-Type: application/json'],
            fn($r) => $r['candidates'][0]['content']['parts'][0]['text'] ?? ''
        );
    }

    private function httpPost(string $url, string $body, array $headers, callable $extractor): string {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error    = curl_error($ch);
        curl_close($ch);

        if ($error || $httpCode >= 400) {
            Logger::error("LLM API error ({$this->provider}) HTTP $httpCode: $error | Response: $response");
            $detail = '';
            if ($response) {
                $decoded = json_decode($response, true);
                $detail  = $decoded['error']['message'] ?? $decoded['error']['type'] ?? '';
            }
            $msg = $httpCode === 401
                ? 'LLM API key is invalid or expired'
                : "LLM API call failed: HTTP $httpCode" . ($detail ? " ($detail)" : '');
            throw new RuntimeException($msg);
        }

        $decoded = json_decode($response, true);
        return $extractor($decoded) ?? '';
    }

    private function parseResponse(string $raw, array $chunks, string $question = ''): array {
        $payload = $this->decodeModelPayload($raw);
        $answer = '';
        $usedSourceIds = [];

        if (is_array($payload)) {
            $answer = trim((string) ($payload['answer'] ?? ''));
            $usedSourceIds = $this->extractUsedSourceIds($payload['usedSources'] ?? []);
        }

        // Legacy [SOURCE N] tags in free-text replies
        if (preg_match_all('/\[SOURCE (\d+)\]/i', $raw, $matches)) {
            $tagIds = array_values(array_unique(array_map('intval', $matches[1] ?? [])));
            if (empty($usedSourceIds)) {
                $usedSourceIds = $tagIds;
            }
            if ($answer === '') {
                $answer = trim(preg_replace('/\[SOURCE \d+\]/i', '', $raw) ?: '');
            }
        }

        // Plain-text reply (model ignored JSON instructions) — still treat as an answer
        if ($answer === '' && trim($raw) !== '') {
            $plain = trim(preg_replace('/^```(?:json)?\s*|\s*```$/i', '', trim($raw)) ?: '');
            if ($plain !== '' && !str_starts_with($plain, '{')) {
                $answer = $plain;
            }
        }

        if ($this->isUnanswered($answer)) {
            return [
                'answer'     => trim($answer === '' ? 'I could not find this information in the available documents.' : $answer),
                'sources'    => [],
                'confidence' => 0.0,
                'answered'   => false,
            ];
        }

        $answer = $this->sanitizeAnswer($answer);
        if ($answer === '' || $this->looksLikeRawDump($answer) || mb_strlen($answer) < 25) {
            Logger::info('[citation] answer rejected as empty/raw dump after sanitize');
            return [
                'answer'     => 'I could not find this information in the available documents.',
                'sources'    => [],
                'confidence' => 0.0,
                'answered'   => false,
            ];
        }

        $sources = [];
        if (!empty($usedSourceIds)) {
            Logger::info('[citation] used_source_ids=' . implode(',', $usedSourceIds));
            $sources = self::resolveSourcesFromIds($usedSourceIds, $chunks);
        }

        // Prefer sources whose chunk text overlaps the answer (correct PDF + page).
        self::requireSourceAttributor();
        if (empty($sources)) {
            $sources = SourceAttributor::attribute($answer, $question, $chunks, $usedSourceIds);
        } else {
            // Keep LLM citations, but re-rank/cap by answer overlap when possible.
            $attributed = SourceAttributor::attribute($answer, $question, $chunks, $usedSourceIds);
            if (!empty($attributed)) {
                $sources = $attributed;
            }
        }
        if (empty($sources)) {
            $sources = SourceAttributor::ensureNonEmptySources([], $chunks);
        }
        if (count($sources) > 2) {
            $sources = array_slice(array_values($sources), 0, 2);
        }

        Logger::info('[citation] final_sources_count=' . count($sources)
            . ' pages=' . implode(',', array_map(
                fn($s) => (string) ($s['pageNumber'] ?? $s['page_number'] ?? '?'),
                $sources
            )));

        return [
            'answer'     => $answer,
            'sources'    => $sources,
            'confidence' => round(count($sources) > 0 ? min(0.95, 0.65 + count($sources) * 0.1) : 0.4, 3),
            'answered'   => true,
        ];
    }

    public static function resolveSourcesFromIds(array $usedSourceIds, array $chunks): array {
        self::requireSourceAttributor();
        $resolved = [];
        $seen = [];

        foreach ($usedSourceIds as $sourceId) {
            $id = is_numeric($sourceId) ? (int) $sourceId : null;
            if ($id === null || $id < 0 || !isset($chunks[$id])) {
                continue;
            }

            $chunk = $chunks[$id];
            if (DocumentParser::isTableOfContentsChunk($chunk['content'] ?? '')) {
                continue;
            }
            $key = $id . ':' . ($chunk['document_id'] ?? '') . ':' . ($chunk['page_number'] ?? '');
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;

            $source = SourceAttributor::chunkToSource($chunk, count($resolved) + 1);
            $source['source_id'] = $id;
            $source['sourceId'] = $id;
            $source['text'] = (string) ($chunk['text'] ?? $chunk['content'] ?? '');
            $resolved[] = $source;
        }

        return SourceAttributor::consolidateByDocument($resolved);
    }

    private function decodeModelPayload(string $raw): ?array {
        $trimmed = trim($raw);
        if ($trimmed === '') {
            return null;
        }

        $trimmed = preg_replace('/^```(?:json)?\s*/i', '', $trimmed) ?? $trimmed;
        $trimmed = preg_replace('/```\s*$/', '', $trimmed) ?? $trimmed;
        $trimmed = trim($trimmed);

        $decoded = json_decode($trimmed, true);
        return is_array($decoded) ? $decoded : null;
    }

    private function extractUsedSourceIds(mixed $value): array {
        if (!is_array($value)) {
            return [];
        }

        $ids = [];
        foreach ($value as $item) {
            if (is_numeric($item)) {
                $id = (int) $item;
                if ($id >= 0) {
                    $ids[] = $id;
                }
            }
        }

        return array_values(array_unique($ids));
    }

    private function isUnanswered(string $answer): bool {
        $trimmed = trim($answer);
        if ($trimmed === '') {
            return true;
        }

        $normalized = mb_strtolower($trimmed);
        return str_starts_with($normalized, 'unanswered:')
            || str_contains($normalized, 'could not find')
            || str_contains($normalized, 'i could not find')
            || str_contains($normalized, 'not found in the knowledge base')
            || str_contains($normalized, 'not found in the available documents');
    }

    /**
     * Same as answer() but accepts the original retrieved chunk list for fallback
     * when the substantive (TOC-filtered) list yields no attributable sources.
     *
     * @param array<int, array<string, mixed>> $allChunks      Full retrieval list
     * @param array<int, array<string, mixed>> $substantiveChunks TOC-filtered list for LLM
     */
    public function answerWithFallback(string $question, array $allChunks, array $substantiveChunks): array {
        $substantive = !empty($substantiveChunks) ? $substantiveChunks : $allChunks;

        // Reuse answer() so source guarantees stay in one place, then fall back to full retrieval list.
        $result = $this->answer($question, $substantive);

        if ($result['answered']) {
            self::requireSourceAttributor();
            $result['sources'] = SourceAttributor::ensureNonEmptySources(
                $result['sources'] ?? [],
                $substantive,
                $allChunks
            );
        }

        Logger::info('[citation] answerWithFallback sources.length=' . count($result['sources'] ?? []));

        return $result;
    }
}
