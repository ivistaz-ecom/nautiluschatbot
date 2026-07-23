<?php
// backend/services/EmbeddingService.php

require_once __DIR__ . '/../core/Logger.php';
require_once __DIR__ . '/../core/Database.php';

/**
 * OpenAI text embeddings for semantic chunk retrieval...
 */


 
class EmbeddingService {
    private string $apiKey;
    private string $model;
    private int $dimensions;
    private bool $enabled;

    public function __construct(?array $cfg = null) {
        $full = $cfg ?? (require __DIR__ . '/../config/config.php');
        $emb  = $full['embeddings'] ?? [];

        $this->apiKey     = trim((string) ($emb['api_key'] ?? ''));
        $this->model      = (string) ($emb['model'] ?? 'text-embedding-3-small');
        $this->dimensions = (int) ($emb['dimensions'] ?? 512);
        $this->enabled    = !empty($emb['enabled']) && $this->apiKey !== '';
    }

    public function isEnabled(): bool {
        return $this->enabled;
    }

    public function modelName(): string {
        return $this->model . '@' . $this->dimensions;
    }

    /** @return float[]|null */
    public function embed(string $text): ?array {
        $batch = $this->embedMany([$text]);
        return $batch[0] ?? null;
    }

    /**
     * @param  array<int, string> $texts
     * @return array<int, float[]|null>
     */
    public function embedMany(array $texts): array {
        if (!$this->enabled || empty($texts)) {
            return array_fill(0, count($texts), null);
        }

        $cleaned = [];
        foreach ($texts as $i => $t) {
            $t = trim(preg_replace('/\s+/u', ' ', (string) $t) ?? '');
            // OpenAI limit ~8192 tokens; keep a safe character budget per chunk.
            if (mb_strlen($t) > 6000) {
                $t = mb_substr($t, 0, 6000);
            }
            $cleaned[$i] = $t === '' ? ' ' : $t;
        }

        $body = json_encode([
            'model'      => $this->model,
            'input'      => array_values($cleaned),
            'dimensions' => $this->dimensions,
        ]);

        $ch = curl_init('https://api.openai.com/v1/embeddings');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $this->apiKey,
                'Content-Type: application/json',
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 120,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);

        $response = curl_exec($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error    = curl_error($ch);
        curl_close($ch);

        if ($error || $httpCode >= 400 || !$response) {
            Logger::error("Embedding API error HTTP $httpCode: $error | $response");
            return array_fill(0, count($texts), null);
        }

        $decoded = json_decode($response, true);
        $data    = $decoded['data'] ?? null;
        if (!is_array($data)) {
            return array_fill(0, count($texts), null);
        }

        usort($data, fn($a, $b) => ($a['index'] ?? 0) <=> ($b['index'] ?? 0));

        $out = [];
        foreach ($texts as $i => $_) {
            $vec = $data[$i]['embedding'] ?? null;
            $out[$i] = is_array($vec) ? array_map('floatval', $vec) : null;
        }
        return $out;
    }

    /** Persist embedding on an existing chunk row. */
    public function embedAndStoreChunk(int $chunkId, string $content): bool {
        $vec = $this->embed($content);
        if ($vec === null) {
            return false;
        }
        Database::execute(
            'UPDATE document_chunks SET embedding = ?, embedding_model = ?, embedded_at = NOW() WHERE id = ?',
            [json_encode($vec), $this->modelName(), $chunkId]
        );
        return true;
    }

    /**
     * Cosine similarity in [0, 1] for same-direction unit-ish vectors
     * (OpenAI embeddings are typically unit-normalized; still normalize here).
     *
     * @param float[] $a
     * @param float[] $b
     */
    public static function cosine(array $a, array $b): float {
        $n = min(count($a), count($b));
        if ($n === 0) {
            return 0.0;
        }
        $dot = 0.0;
        $na  = 0.0;
        $nb  = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $x = (float) $a[$i];
            $y = (float) $b[$i];
            $dot += $x * $y;
            $na  += $x * $x;
            $nb  += $y * $y;
        }
        if ($na <= 0.0 || $nb <= 0.0) {
            return 0.0;
        }
        $sim = $dot / (sqrt($na) * sqrt($nb));
        // Map roughly [-1,1] → [0,1]
        return max(0.0, min(1.0, ($sim + 1.0) / 2.0));
    }

    /**
     * Cosine for unit-normalized OpenAI vectors (faster): clamp to [0,1].
     *
     * @param float[] $a
     * @param float[] $b
     */
    public static function cosineUnit(array $a, array $b): float {
        $n = min(count($a), count($b));
        if ($n === 0) {
            return 0.0;
        }
        $dot = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $dot += (float) $a[$i] * (float) $b[$i];
        }
        return max(0.0, min(1.0, $dot));
    }
}
