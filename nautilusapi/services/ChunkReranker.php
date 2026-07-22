<?php
// backend/services/ChunkReranker.php

require_once __DIR__ . '/DocumentParser.php';

/**
 * Re-ranks FULLTEXT retrieval results so substantive, on-topic answer pages
 * outrank TOC/index hits and pages that only share a single common word.
 */
class ChunkReranker {

    /**
     * @param  array<int, array<string, mixed>> $chunks
     * @return array<int, array<string, mixed>>
     */
    public function rerank(array $chunks, string $question): array {
        foreach ($chunks as &$chunk) {
            $chunk['rerank_score'] = $this->computeScore($chunk, $question);
            $chunk['phrase_score'] = self::phraseMatchScore($chunk['content'] ?? '', $question);
            $chunk['coverage']     = self::topicCoverage($chunk['content'] ?? '', $question);
        }
        unset($chunk);

        usort($chunks, fn($a, $b) => ($b['rerank_score'] ?? 0) <=> ($a['rerank_score'] ?? 0));

        return $chunks;
    }

    /**
     * Drop chunks that only share weak/generic keyword overlap with the question.
     *
     * @param  array<int, array<string, mixed>> $chunks
     * @return array<int, array<string, mixed>>
     */
    public function filterWeakTopicChunks(array $chunks, string $question): array {
        $terms = $this->significantTerms($question);
        if (count($terms) < 2) {
            return $chunks;
        }

        $filtered = array_values(array_filter($chunks, function ($chunk) use ($question) {
            $phrase = (float) ($chunk['phrase_score'] ?? self::phraseMatchScore($chunk['content'] ?? '', $question));
            $cover  = (float) ($chunk['coverage'] ?? self::topicCoverage($chunk['content'] ?? '', $question));
            // Keep strong phrase hits, or pages covering most topic words.
            return $phrase >= 0.55 || $cover >= 0.6;
        }));

        // Never wipe the whole set — keep top-ranked originals if filter is too strict.
        return !empty($filtered) ? $filtered : array_slice($chunks, 0, min(3, count($chunks)));
    }

    /**
     * Combine the DB FULLTEXT score with content-quality + topic signals.
     */
    public function computeScore(array $chunk, string $question): float {
        $content = $chunk['content'] ?? '';
        $base    = max(0.01, (float) ($chunk['score'] ?? 1.0));

        // TOC/index chunks match keywords but never contain the answer body.
        if (DocumentParser::isTableOfContentsChunk($content)) {
            return $base * 0.02;
        }

        $base *= self::substanceMultiplier($content);
        $overlap = $this->questionTermOverlap($content, $question);
        $base *= 1.0 + $overlap;

        $phrase = self::phraseMatchScore($content, $question);
        $cover  = self::topicCoverage($content, $question);

        // Strong topic-phrase match dominates keyword-only pages.
        $base *= 1.0 + ($phrase * 1.8);
        $base *= 0.55 + ($cover * 0.9);

        // Penalise pages that only hit one generic word.
        if ($phrase < 0.4 && $cover < 0.5) {
            $base *= 0.35;
        }

        return $base;
    }

    /**
     * Boost chunks with explanatory prose; penalise heading/list-only text.
     */
    public static function substanceMultiplier(string $content): float {
        $sentences = preg_split('/[.!?]+/u', $content, -1, PREG_SPLIT_NO_EMPTY);
        $count     = count($sentences);
        if ($count === 0) {
            return 0.5;
        }

        $totalLen = 0;
        foreach ($sentences as $sentence) {
            $totalLen += mb_strlen(trim($sentence));
        }
        $avgLen = $totalLen / $count;

        if ($avgLen >= 40 && $avgLen <= 280) {
            return 1.5;
        }
        if ($avgLen < 25) {
            return 0.55;
        }

        return 1.0;
    }

    public static function substanceScore(string $content): float {
        return self::substanceMultiplier($content);
    }

    /**
     * Score how well text matches multi-word topic phrases from the question
     * (e.g. "hot work procedure", "superintendent inspections").
     */
    public static function phraseMatchScore(string $text, string $question): float {
        $lower = mb_strtolower($text);
        $phrases = self::extractTopicPhrases($question);
        if (empty($phrases)) {
            return 0.0;
        }

        $best = 0.0;
        foreach ($phrases as $phrase) {
            if ($phrase === '') {
                continue;
            }
            if (str_contains($lower, $phrase)) {
                $parts = preg_split('/\s+/', $phrase, -1, PREG_SPLIT_NO_EMPTY);
                $best = max($best, count($parts) >= 3 ? 1.0 : 0.85);
                continue;
            }

            $parts = preg_split('/\s+/', $phrase, -1, PREG_SPLIT_NO_EMPTY);
            if (count($parts) < 2) {
                continue;
            }

            $allPresent = true;
            $idxs = [];
            foreach ($parts as $part) {
                $pos = mb_strpos($lower, $part);
                if ($pos === false) {
                    // light plural tolerance
                    $stem = rtrim($part, 's');
                    $pos = $stem !== '' ? mb_strpos($lower, $stem) : false;
                }
                if ($pos === false) {
                    $allPresent = false;
                    break;
                }
                $idxs[] = $pos;
            }

            if ($allPresent && !empty($idxs)) {
                $span = max($idxs) - min($idxs);
                if ($span <= 50) {
                    $best = max($best, 0.7);
                } else {
                    $best = max($best, 0.45);
                }
            }
        }

        return $best;
    }

    /** Fraction of significant question terms present in the text. */
    public static function topicCoverage(string $text, string $question): float {
        $terms = (new self())->significantTerms($question);
        if (empty($terms)) {
            return 1.0;
        }
        $lower = mb_strtolower($text);
        $hits = 0;
        foreach ($terms as $term) {
            if (str_contains($lower, $term) || str_contains($lower, rtrim($term, 's'))) {
                $hits++;
            }
        }
        return $hits / count($terms);
    }

    /** @return string[] */
    public static function extractTopicPhrases(string $question): array {
        $words = preg_split(
            '/\s+/u',
            mb_strtolower(preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $question)),
            -1,
            PREG_SPLIT_NO_EMPTY
        );
        $stop = [
            'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'what', 'how',
            'when', 'where', 'why', 'who', 'which', 'this', 'that', 'and', 'or', 'of',
            'in', 'for', 'to', 'with', 'on', 'at', 'by', 'from', 'do', 'does', 'did',
            'please', 'tell', 'give', 'explain', 'describe', 'about', 'into',
        ];
        $terms = [];
        foreach ($words as $w) {
            if (mb_strlen($w) >= 3 && !in_array($w, $stop, true)) {
                $terms[] = $w;
            }
        }
        $terms = array_values(array_unique($terms));
        if (count($terms) < 2) {
            return $terms;
        }

        $phrases = [];
        // Full topic string
        $phrases[] = implode(' ', $terms);
        // Adjacent bigrams / trigrams
        for ($i = 0; $i < count($terms) - 1; $i++) {
            $phrases[] = $terms[$i] . ' ' . $terms[$i + 1];
            if ($i + 2 < count($terms)) {
                $phrases[] = $terms[$i] . ' ' . $terms[$i + 1] . ' ' . $terms[$i + 2];
            }
        }

        return array_values(array_unique($phrases));
    }

    private function questionTermOverlap(string $content, string $question): float {
        $qTerms = $this->significantTerms($question);
        if (empty($qTerms)) {
            return 0.0;
        }

        $contentLower = mb_strtolower($content);
        $hits         = 0;
        foreach ($qTerms as $term) {
            if (str_contains($contentLower, $term)) {
                $hits++;
            }
        }

        return $hits / count($qTerms);
    }

    /** @return string[] */
    private function significantTerms(string $text): array {
        $words = preg_split(
            '/\s+/u',
            mb_strtolower(preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $text)),
            -1,
            PREG_SPLIT_NO_EMPTY
        );

        $stop = [
            'a', 'an', 'the', 'is', 'are', 'was', 'what', 'how', 'when', 'where',
            'why', 'who', 'which', 'this', 'that', 'and', 'or', 'of', 'in', 'for',
            'to', 'with', 'on', 'at', 'by', 'from', 'be', 'do', 'does', 'did',
            'please', 'tell', 'give', 'explain', 'describe', 'about',
        ];

        $terms = [];
        foreach ($words as $word) {
            if (mb_strlen($word) >= 3 && !in_array($word, $stop, true)) {
                $terms[] = $word;
            }
        }

        return array_values(array_unique($terms));
    }
}
