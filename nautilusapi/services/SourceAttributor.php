<?php
// backend/services/SourceAttributor.php

require_once __DIR__ . '/DocumentParser.php';
require_once __DIR__ . '/ChunkReranker.php';
require_once __DIR__ . '/../core/Logger.php';

/**
 * Selects which page number(s) to display in chat Sources.
 *
 * IMPORTANT: The displayed page is NEVER taken from the first retrieved chunk,
 * the highest FULLTEXT score, or the first vector-search hit. It is chosen by
 * comparing the generated answer text against every retrieved chunk and picking
 * the chunk(s) with the highest textual overlap — excluding TOC/index chunks.
 *
 * Flow:
 *   retrieveChunks() → LLM generates answer → attribute(answer, chunks)
 *   → score each non-TOC chunk vs answer → pick best overlap → return page_number
 */
class SourceAttributor {

    /**
     * @param  array<int, array<string, mixed>> $chunks        Retrieved chunks (0-indexed)
     * @param  int[]                              $citedIndices  LLM [SOURCE N] tags (logged only)
     * @return array<int, array<string, mixed>>
     */
    public static function attribute(string $answer, string $question, array $chunks, array $citedIndices = []): array {
        $scored = self::scoreChunksAgainstAnswer($answer, $question, $chunks);

        self::logAttributionDecision($answer, $question, $chunks, $scored, $citedIndices);

        $sources = [];
        $method  = 'answer_overlap';

        if (!empty($scored)) {
            // Always include the best overlap match; add others within 65% of top score.
            $bestScore    = $scored[0]['score'];
            $cutoff       = $bestScore * 0.65;
            $contributing = [];

            foreach ($scored as $rank => $item) {
                if ($rank === 0 || $item['score'] >= $cutoff) {
                    $contributing[$item['index']] = $item['chunk'];
                }
            }

            $sources = self::consolidateByDocument(
                self::chunksToRawSources($contributing, $scored)
            );
        }

        // Fallback: overlap could not distinguish chunks (LLM paraphrase) — use the
        // highest-ranked retrieved chunk (post-rerank), preferring non-TOC pages.
        if (empty($sources) && !empty($chunks)) {
            $sources = self::fallbackSources($chunks);
            $method  = 'retrieval_fallback';
            Logger::info('[source-attribution] Overlap produced no sources — using retrieval fallback');
        }

        Logger::info('[source-attribution] final_sources=' . count($sources)
            . ' method=' . $method
            . ' pages=' . implode(',', array_map(
                fn($s) => (string) ($s['pageNumber'] ?? $s['page_number'] ?? '?'),
                $sources
            )));

        return $sources;
    }

    /**
     * Score every non-TOC chunk by how much of the answer text it explains.
     *
     * @param  array<int, array<string, mixed>> $chunks
     * @return array<int, array{index: int, chunk: array, score: float, breakdown: array}>
     */
    private static function scoreChunksAgainstAnswer(string $answer, string $question, array $chunks): array {
        $scored = [];

        foreach ($chunks as $i => $chunk) {
            $content = $chunk['content'] ?? '';

            if (DocumentParser::isTableOfContentsChunk($content)) {
                continue;
            }
            if (mb_strlen(trim($content)) < 30) {
                continue;
            }

            $breakdown     = self::computeAnswerOverlap($answer, $content);
            $answerOverlap = $breakdown['total'];
            $queryOverlap  = self::overlapRatio(
                self::tokenize($question),
                self::tokenize($content)
            );
            $substance     = ChunkReranker::substanceScore($content);

            // Answer overlap is the primary signal (×5); retrieval score is a weak tiebreaker.
            $score = ($answerOverlap * 5.0)
                + ($queryOverlap * 0.5)
                + ($substance * 0.3)
                + ((float) ($chunk['rerank_score'] ?? $chunk['score'] ?? 0) * 0.05);

            $scored[] = [
                'index'     => $i,
                'chunk'     => $chunk,
                'score'     => round($score, 4),
                'breakdown' => array_merge($breakdown, [
                    'query_overlap' => round($queryOverlap, 4),
                    'substance'     => round($substance, 4),
                ]),
            ];
        }

        usort($scored, fn($a, $b) => $b['score'] <=> $a['score']);

        return $scored;
    }

    /**
     * Multi-signal overlap between generated answer and chunk body.
     *
     * @return array{token_fwd: float, token_rev: float, phrase: float, contains: float, total: float}
     */
    private static function computeAnswerOverlap(string $answer, string $chunkContent): array {
        $answerTokens = self::tokenize($answer);
        $chunkTokens  = self::tokenize($chunkContent);

        $tokenFwd = self::overlapRatio($answerTokens, $chunkTokens);
        $tokenRev = self::overlapRatio($chunkTokens, $answerTokens);
        $phrase   = self::ngramOverlap($answer, $chunkContent, 3);
        $contains = self::phraseContainmentScore($answer, $chunkContent);

        $total = ($tokenFwd * 0.35) + ($tokenRev * 0.25) + ($phrase * 0.25) + ($contains * 0.15);

        return [
            'token_fwd' => round($tokenFwd, 4),
            'token_rev' => round($tokenRev, 4),
            'phrase'    => round($phrase, 4),
            'contains'  => round($contains, 4),
            'total'     => round($total, 4),
        ];
    }

    /** Fraction of answer 3-grams found inside the chunk. */
    private static function ngramOverlap(string $answer, string $chunk, int $n): float {
        $aWords = self::tokenize($answer);
        if (count($aWords) < $n) {
            return self::overlapRatio($aWords, self::tokenize($chunk));
        }

        $chunkLower = mb_strtolower($chunk);
        $total      = 0;
        $hits       = 0;

        for ($i = 0; $i <= count($aWords) - $n; $i++) {
            $gram = implode(' ', array_slice($aWords, $i, $n));
            $total++;
            if (str_contains($chunkLower, $gram)) {
                $hits++;
            }
        }

        return $total > 0 ? $hits / $total : 0.0;
    }

    /** Check whether multi-word phrases from the answer appear verbatim in the chunk. */
    private static function phraseContainmentScore(string $answer, string $chunk): float {
        $chunkLower = mb_strtolower($chunk);
        $words      = self::tokenize($answer);
        if (count($words) < 4) {
            return 0.0;
        }

        $phrases = [];
        for ($len = 4; $len <= min(8, count($words)); $len++) {
            for ($i = 0; $i <= count($words) - $len; $i++) {
                $phrases[] = implode(' ', array_slice($words, $i, $len));
            }
        }

        if (empty($phrases)) {
            return 0.0;
        }

        $hits = 0;
        foreach ($phrases as $phrase) {
            if (mb_strlen($phrase) >= 15 && str_contains($chunkLower, $phrase)) {
                $hits++;
            }
        }

        return min(1.0, $hits / max(1, count($phrases) * 0.15));
    }

    /**
     * @param  array<int, array<string, mixed>>     $chunks
     * @param  array<int, array<string, mixed>>     $scored
     */
    private static function logAttributionDecision(
        string $answer,
        string $question,
        array $chunks,
        array $scored,
        array $citedIndices
    ): void {
        $retrieved = [];
        foreach ($chunks as $i => $chunk) {
            $content = $chunk['content'] ?? '';
            $retrieved[] = sprintf(
                '  [%d] page=%s fulltext=%s rerank=%s is_toc=%s preview=%s',
                $i,
                $chunk['page_number'] ?? '?',
                isset($chunk['score']) ? round((float) $chunk['score'], 3) : 'n/a',
                isset($chunk['rerank_score']) ? round((float) $chunk['rerank_score'], 3) : 'n/a',
                DocumentParser::isTableOfContentsChunk($content) ? 'YES' : 'no',
                mb_substr(preg_replace('/\s+/', ' ', $content), 0, 80)
            );
        }

        $ranked = [];
        foreach ($scored as $rank => $item) {
            $ranked[] = sprintf(
                '  #%d page=%s attribution_score=%s answer_overlap=%s (fwd=%s rev=%s phrase=%s)',
                $rank + 1,
                $item['chunk']['page_number'] ?? '?',
                $item['score'],
                $item['breakdown']['total'] ?? '?',
                $item['breakdown']['token_fwd'] ?? '?',
                $item['breakdown']['token_rev'] ?? '?',
                $item['breakdown']['phrase'] ?? '?'
            );
        }

        $selectedPage = $scored[0]['chunk']['page_number'] ?? 'none';
        $reason       = empty($scored)
            ? 'no non-TOC chunk scored above threshold'
            : sprintf(
                'highest answer-text overlap (score=%s, page=%s)',
                $scored[0]['score'],
                $selectedPage
            );

        Logger::info("[source-attribution]\n"
            . "question: {$question}\n"
            . "answer_preview: " . mb_substr($answer, 0, 120) . "\n"
            . "llm_cited_indices: " . (empty($citedIndices) ? 'none' : implode(',', $citedIndices)) . "\n"
            . "retrieved_chunks:\n" . implode("\n", $retrieved) . "\n"
            . "ranked_by_answer_overlap:\n" . (empty($ranked) ? "  (none)\n" : implode("\n", $ranked) . "\n")
            . "selected_source_page: {$selectedPage}\n"
            . "selection_reason: {$reason}");
    }

    /**
     * @param  array<int, array<string, mixed>> $chunks
     * @param  array<int, array<string, mixed>> $scored
     * @return array<int, array<string, mixed>>
     */
    private static function chunksToRawSources(array $chunks, array $scored): array {
        // Preserve overlap-rank order (best match first).
        $scoreByIndex = [];
        foreach ($scored as $rank => $item) {
            $scoreByIndex[$item['index']] = ['score' => $item['score'], 'rank' => $rank];
        }

        uksort($chunks, function ($a, $b) use ($scoreByIndex) {
            $ra = $scoreByIndex[$a]['rank'] ?? 999;
            $rb = $scoreByIndex[$b]['rank'] ?? 999;
            return $ra <=> $rb;
        });

        $sources = [];
        foreach ($chunks as $chunk) {
            $fileId     = (int) ($chunk['document_id'] ?? 0);
            $fileName   = $chunk['title'] ?? '';
            $pageNumber = isset($chunk['page_number']) && (int) $chunk['page_number'] > 0
                ? (int) $chunk['page_number']
                : null;

            $sources[] = [
                'document_id'    => $fileId,
                'document_title' => $fileName,
                'page_number'    => $pageNumber,
                'relevance_rank' => count($sources) + 1,
                'mime_type'      => $chunk['mime_type'] ?? 'application/pdf',
                'fileId'         => $fileId,
                'fileName'       => $fileName,
                'pageNumber'     => $pageNumber,
                'score'          => null,
            ];
        }

        return $sources;
    }

    /**
     * Merge consecutive pages from the same document into "Pages 49–50".
     *
     * @param  array<int, array<string, mixed>> $sources
     * @return array<int, array<string, mixed>>
     */
    public static function consolidateByDocument(array $sources): array {
        $byDoc = [];

        foreach ($sources as $src) {
            $docId = (int) ($src['document_id'] ?? 0);
            if ($docId <= 0) {
                continue;
            }
            if (!isset($byDoc[$docId])) {
                $byDoc[$docId] = ['meta' => $src, 'pages' => []];
            }
            $page = $src['page_number'] ?? $src['pageNumber'] ?? null;
            if ($page !== null && (int) $page > 0) {
                $byDoc[$docId]['pages'][(int) $page] = true;
            }
        }

        $consolidated = [];
        foreach ($byDoc as $group) {
            $pages = array_keys($group['pages']);
            sort($pages, SORT_NUMERIC);
            $meta = $group['meta'];

            if (empty($pages)) {
                $consolidated[] = $meta;
                continue;
            }

            foreach (self::pagesToRanges($pages) as $range) {
                $entry = $meta;
                $entry['page_number'] = $range['start'];
                $entry['pageNumber']  = $range['start'];
                $entry['page_end']    = $range['end'] !== $range['start'] ? $range['end'] : null;
                $entry['pageEnd']     = $entry['page_end'];
                $entry['page_label']  = $range['end'] !== $range['start']
                    ? "Pages {$range['start']}–{$range['end']}"
                    : "Page {$range['start']}";
                $entry['pageLabel']   = $entry['page_label'];
                $consolidated[]       = $entry;
            }
        }

        return $consolidated;
    }

    /**
     * Fallback when answer-overlap cannot pick a source: use the highest-ranked
     * retrieved chunk (rerank_score / FULLTEXT score), skipping TOC when possible.
     *
     * @param  array<int, array<string, mixed>> $chunks
     * @return array<int, array<string, mixed>>
     */
    public static function fallbackSources(array $chunks): array {
        if (empty($chunks)) {
            return [];
        }

        $ranked = $chunks;

        // Prefer non-TOC chunks sorted by rerank then FULLTEXT score.
        usort($ranked, function ($a, $b) {
            $aToc = DocumentParser::isTableOfContentsChunk($a['content'] ?? '') ? 1 : 0;
            $bToc = DocumentParser::isTableOfContentsChunk($b['content'] ?? '') ? 1 : 0;
            if ($aToc !== $bToc) {
                return $aToc <=> $bToc;
            }
            $aScore = (float) ($a['rerank_score'] ?? $a['score'] ?? 0);
            $bScore = (float) ($b['rerank_score'] ?? $b['score'] ?? 0);
            return $bScore <=> $aScore;
        });

        $best = null;
        foreach ($ranked as $chunk) {
            if (!DocumentParser::isTableOfContentsChunk($chunk['content'] ?? '')) {
                $best = $chunk;
                break;
            }
        }
        // Never cite a TOC/index page — better empty sources than a wrong #page= link.
        if ($best === null) {
            return [];
        }

        $fileId     = (int) ($best['document_id'] ?? 0);
        $fileName   = $best['title'] ?? '';
        $pageNumber = isset($best['page_number']) && (int) $best['page_number'] > 0
            ? (int) $best['page_number']
            : null;

        if ($fileId <= 0) {
            return [];
        }

        $raw = [[
            'document_id'    => $fileId,
            'document_title' => $fileName,
            'page_number'    => $pageNumber,
            'relevance_rank' => 1,
            'mime_type'      => $best['mime_type'] ?? 'application/pdf',
            'fileId'         => $fileId,
            'fileName'       => $fileName,
            'pageNumber'     => $pageNumber,
            'score'          => isset($best['rerank_score'])
                ? round((float) $best['rerank_score'], 4)
                : (isset($best['score']) ? round((float) $best['score'], 4) : null),
        ]];

        return self::consolidateByDocument($raw);
    }

    /**
     * Build a source object from a retrieved chunk row (FULLTEXT / rerank result).
     *
     * @param  array<string, mixed> $chunk
     * @return array<string, mixed>
     */
    public static function chunkToSource(array $chunk, int $rank = 1): array {
        $fileId = (int) ($chunk['document_id'] ?? $chunk['fileId'] ?? 0);
        $fileName = (string) ($chunk['title'] ?? $chunk['fileName'] ?? $chunk['document_title'] ?? 'Document');
        $pageNumber = null;
        if (isset($chunk['page_number']) && (int) $chunk['page_number'] > 0) {
            $pageNumber = (int) $chunk['page_number'];
        } elseif (isset($chunk['pageNumber']) && (int) $chunk['pageNumber'] > 0) {
            $pageNumber = (int) $chunk['pageNumber'];
        }

        $score = isset($chunk['rerank_score'])
            ? round((float) $chunk['rerank_score'], 4)
            : (isset($chunk['score']) ? round((float) $chunk['score'], 4) : null);

        $source = [
            'document_id'    => $fileId,
            'document_title' => $fileName,
            'page_number'    => $pageNumber,
            'relevance_rank' => $rank,
            'mime_type'      => $chunk['mime_type'] ?? 'application/pdf',
            'category_id'    => isset($chunk['category_id']) ? (int) $chunk['category_id'] : null,
            'category_name'  => $chunk['category_name'] ?? null,
            'fileId'         => $fileId,
            'fileName'       => $fileName,
            'pageNumber'     => $pageNumber,
            'score'          => $score,
        ];

        if ($pageNumber !== null) {
            $source['page_label'] = "page {$pageNumber}";
            $source['pageLabel']  = $source['page_label'];
        }

        return $source;
    }

    /**
     * Guarantee at least one source whenever retrieved chunks exist.
     * Tries attribution result first, then fallback lists in order.
     *
     * @param  array<int, array<string, mixed>> $sources
     * @param  array<int, array<string, mixed>> ...$chunkLists
     * @return array<int, array<string, mixed>>
     */
    public static function ensureNonEmptySources(array $sources, array ...$chunkLists): array {
        if (!empty($sources)) {
            return $sources;
        }

        foreach ($chunkLists as $list) {
            if (empty($list)) {
                continue;
            }
            $fallback = self::fallbackSources($list);
            if (!empty($fallback)) {
                Logger::info('[source-attribution] ensureNonEmptySources: used fallbackSources on list of ' . count($list));
                return $fallback;
            }
        }

        foreach ($chunkLists as $list) {
            if (empty($list)) {
                continue;
            }
            $nonToc = self::firstNonTocChunk($list);
            if ($nonToc === null) {
                continue;
            }
            $raw = self::consolidateByDocument([self::chunkToSource($nonToc)]);
            Logger::info('[source-attribution] ensureNonEmptySources: used first non-TOC chunk page='
                . ($nonToc['page_number'] ?? '?'));
            return $raw;
        }

        return [];
    }

    /**
     * @param  array<int, array<string, mixed>> $chunks
     * @return array<string, mixed>|null
     */
    public static function firstNonTocChunk(array $chunks): ?array {
        foreach ($chunks as $chunk) {
            if (!DocumentParser::isTableOfContentsChunk($chunk['content'] ?? '')) {
                return $chunk;
            }
        }
        return null;
    }

    /** @param int[] $pages */
    private static function pagesToRanges(array $pages): array {
        if (empty($pages)) {
            return [];
        }

        $ranges = [];
        $start  = $pages[0];
        $prev   = $pages[0];

        for ($i = 1, $n = count($pages); $i < $n; $i++) {
            if ($pages[$i] === $prev + 1) {
                $prev = $pages[$i];
                continue;
            }
            $ranges[] = ['start' => $start, 'end' => $prev];
            $start    = $pages[$i];
            $prev     = $pages[$i];
        }

        $ranges[] = ['start' => $start, 'end' => $prev];

        return $ranges;
    }

    /** @return string[] */
    private static function tokenize(string $text): array {
        $words = preg_split(
            '/\s+/u',
            mb_strtolower(preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $text)),
            -1,
            PREG_SPLIT_NO_EMPTY
        );

        $stop = [
            'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on',
            'with', 'at', 'by', 'from', 'as', 'this', 'that', 'these', 'those',
            'and', 'but', 'or', 'not', 'no', 'it', 'its', 'also', 'shall', 'process',
        ];

        $tokens = [];
        foreach ($words as $word) {
            if (mb_strlen($word) >= 3 && !in_array($word, $stop, true)) {
                $tokens[] = $word;
            }
        }

        return array_values(array_unique($tokens));
    }

    /** @param string[] $a @param string[] $b */
    private static function overlapRatio(array $a, array $b): float {
        if (empty($a) || empty($b)) {
            return 0.0;
        }
        $bLookup = array_flip($b);
        $hits    = 0;
        foreach ($a as $token) {
            if (isset($bLookup[$token])) {
                $hits++;
            }
        }
        return $hits / count($a);
    }
}
