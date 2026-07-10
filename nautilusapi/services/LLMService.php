<?php
// backend/services/LLMService.php

require_once __DIR__ . '/SourceAttributor.php';
require_once __DIR__ . '/DocumentParser.php';
require_once __DIR__ . '/../core/Logger.php';

class LLMService {
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

        // Re-index 0..N so [SOURCE N] tags align with the filtered list.
        if (empty($substantive)) {
            $substantive = $chunks; // last resort if everything was filtered
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
            $content = trim((string) ($chunk['content'] ?? ''));
            $parts[] = "SOURCE {$i}\nFile: {$fileName}\nPage: {$pageNumber}\nText:\n{$content}";
        }
        return implode("\n\n-------------------\n\n", $parts);
    }

    private function buildPrompt(string $question, string $context): string {
        return <<<PROMPT
You are a knowledge assistant for Nautilus Shipping. Answer questions using ONLY the document excerpts provided below. Do NOT use any external knowledge.

Return STRICT JSON only with exactly these fields:
{
  "answer": "short answer",
  "usedSources": [0, 2]
}

Rules:
- Use the SOURCE IDs from the document excerpts below.
- If the answer is based on the documents, include at least one source ID in usedSources.
- If multiple sources contributed, include all relevant source IDs.
- Do not invent source IDs.
- Do not cite table-of-contents or index entries unless they actually contain the answer.
- If the answer is not found in the provided sources, return:
{
  "answer": "I could not find this information in the available documents.",
  "usedSources": []
}
- Never make up information.

--- DOCUMENT EXCERPTS ---
{$context}
--- END EXCERPTS ---

Question: {$question}

Response:
PROMPT;
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

        $sources = [];
        if (!empty($usedSourceIds)) {
            Logger::info('[citation] used_source_ids=' . implode(',', $usedSourceIds));
            $sources = self::resolveSourcesFromIds($usedSourceIds, $chunks);
        }

        // ALWAYS attach at least one source for document-backed answers
        $sources = SourceAttributor::ensureNonEmptySources($sources, $chunks);

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
        $resolved = [];
        $seen = [];

        foreach ($usedSourceIds as $sourceId) {
            $id = is_numeric($sourceId) ? (int) $sourceId : null;
            if ($id === null || $id < 0 || !isset($chunks[$id])) {
                continue;
            }

            $chunk = $chunks[$id];
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
            || str_contains($normalized, 'could not find this information')
            || str_contains($normalized, 'i could not find this information');
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
