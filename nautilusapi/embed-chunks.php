#!/usr/bin/env php
<?php
/**
 * Backfill OpenAI embeddings for existing document_chunks.
 *
 * On Hostinger (SSH or "Run PHP script"):
 *   php embed-chunks.php
 *
 * Safe to re-run: only rows with embedding IS NULL are processed.
 */
declare(strict_types=1);

$baseDir = __DIR__;
require_once $baseDir . '/core/Database.php';
require_once $baseDir . '/core/Logger.php';
require_once $baseDir . '/core/Response.php';
require_once $baseDir . '/core/Request.php';
require_once $baseDir . '/services/EmbeddingService.php';

$cfg = require $baseDir . '/config/config.php';
$embedder = new EmbeddingService($cfg);

if (!$embedder->isEnabled()) {
    fwrite(STDERR, "Embeddings disabled or EMBEDDING_API_KEY / OPENAI_API_KEY missing in .env\n");
    exit(1);
}

$batchSize = 32;
$totalDone = 0;
$totalFail = 0;

echo "Embedding model: " . $embedder->modelName() . "\n";

while (true) {
    $rows = Database::query(
        "SELECT id, content FROM document_chunks
         WHERE embedding IS NULL
         ORDER BY id ASC
         LIMIT " . (int) $batchSize
    );
    if (empty($rows)) {
        break;
    }

    $ids    = array_map(fn($r) => (int) $r['id'], $rows);
    $texts  = array_map(fn($r) => (string) $r['content'], $rows);
    $vectors = $embedder->embedMany($texts);

    foreach ($ids as $i => $id) {
        $vec = $vectors[$i] ?? null;
        if ($vec === null) {
            $totalFail++;
            echo "FAIL chunk $id\n";
            continue;
        }
        Database::execute(
            'UPDATE document_chunks SET embedding = ?, embedding_model = ?, embedded_at = NOW() WHERE id = ?',
            [json_encode($vec), $embedder->modelName(), $id]
        );
        $totalDone++;
    }

    echo "Embedded batch ending id={$ids[count($ids)-1]} (done=$totalDone fail=$totalFail)\n";
    usleep(200000);
}

echo "Done. embedded=$totalDone failed=$totalFail\n";
Logger::info("embed-chunks.php finished embedded=$totalDone failed=$totalFail");
