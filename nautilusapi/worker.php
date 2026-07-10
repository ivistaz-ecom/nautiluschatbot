#!/usr/bin/env php
<?php
// backend/worker.php — Run as: php worker.php
// This processes queued document parsing jobs.
// Set up as a cron or supervisor daemon.

$baseDir = __DIR__;
require_once $baseDir . '/core/Database.php';
require_once $baseDir . '/core/Logger.php';
require_once $baseDir . '/core/Response.php'; // needed by Database
require_once $baseDir . '/core/Request.php';
require_once $baseDir . '/services/DocumentParser.php';

function processJobs(): void {
    $cfg = require __DIR__ . '/config/config.php';

    while (true) {
        // Pick next queued job
        $job = Database::queryOne(
            "SELECT dj.id AS job_id, dj.document_id, d.storage_path, d.mime_type
             FROM document_jobs dj
             JOIN documents d ON d.id = dj.document_id
             WHERE dj.status = 'queued' AND dj.attempts < 3
             ORDER BY dj.created_at ASC
             LIMIT 1"
        );

        if (!$job) {
            sleep(5); // Poll every 5 seconds
            continue;
        }

        Logger::info("Worker: processing document ID {$job['document_id']}");

        try {
            Database::execute(
                "UPDATE document_jobs SET status = 'processing', attempts = attempts + 1 WHERE id = ?",
                [$job['job_id']]
            );
            Database::execute(
                "UPDATE documents SET status = 'processing' WHERE id = ?",
                [$job['document_id']]
            );

            Logger::info('Worker: Starting PDF parse ' . json_encode(['file' => $job['storage_path'], 'document_id' => $job['document_id']]));
            $parser = new DocumentParser();
            $pages  = $job['mime_type'] === 'application/pdf'
                ? $parser->parsePdf($job['storage_path'])
                : $parser->parseDocx($job['storage_path']);

            Logger::info('Worker: PDF parsed ' . json_encode(['document_id' => $job['document_id'], 'pages_detected' => count($pages)]));
            foreach ($pages as $pageNumber => $pageText) {
                Logger::info('Worker: Parsed page ' . json_encode([
                    'document_id' => $job['document_id'],
                    'page' => $pageNumber,
                    'length' => strlen($pageText),
                    'preview' => substr(trim($pageText), 0, 150),
                ]));
            }

            $chunkSize    = $cfg['llm']['chunk_size'];
            $chunkOverlap = $cfg['llm']['chunk_overlap'];

            Logger::info('Worker: pages_detected=' . count($pages) . ' for document ID ' . $job['document_id']);
            $chunkCount = 0;
            foreach ($pages as $pageNum => $text) {
                Logger::info('Worker: page=' . $pageNum . ' length=' . strlen($text) . ' for document ID ' . $job['document_id']);
                // Skip blank pages; keep $pageNum as the original PDF page for #page= deep links.
                if (!trim($text)) {
                    continue;
                }

                // Exclude TOC/index pages from the searchable chunk index.
                if (DocumentParser::isTableOfContentsPage($text)) {
                    continue;
                }

                $chunks = $parser->chunkText($text, $chunkSize, $chunkOverlap);
                Logger::info('Worker: Creating chunks ' . json_encode(['document_id' => $job['document_id'], 'page' => $pageNum, 'chunk_count' => count($chunks)]));
                foreach ($chunks as $idx => $chunk) {
                    if (DocumentParser::isTableOfContentsChunk($chunk)) {
                        continue;
                    }
                    Logger::info('Worker: Saving chunk ' . json_encode(['document_id' => $job['document_id'], 'page_number' => $pageNum, 'length' => strlen($chunk)]));
                    Database::insert(
                        'INSERT INTO document_chunks (document_id, page_number, chunk_index, content) VALUES (?,?,?,?)',
                        [$job['document_id'], $pageNum, $idx, $chunk]
                    );
                    $chunkCount++;
                }
            }

            $keywords = $parser->extractKeywords($pages);

            Database::execute(
                "UPDATE documents SET status='ready', page_count=?, keywords=? WHERE id=?",
                [count($pages), $keywords, $job['document_id']]
            );
            Database::execute(
                "UPDATE document_jobs SET status='done' WHERE id=?",
                [$job['job_id']]
            );

            Logger::info('Worker: Ingestion completed ' . json_encode(['document_id' => $job['document_id'], 'pages' => count($pages), 'chunks' => $chunkCount]));
            Logger::info("Worker: completed document ID {$job['document_id']} ({$job['page_count']} pages)");

        } catch (Exception $e) {
            Logger::error("Worker: failed document ID {$job['document_id']}: " . $e->getMessage());
            Database::execute(
                "UPDATE document_jobs SET status='failed', error_message=? WHERE id=?",
                [$e->getMessage(), $job['job_id']]
            );
            Database::execute(
                "UPDATE documents SET status='error', error_message=? WHERE id=?",
                [$e->getMessage(), $job['document_id']]
            );
        }

        sleep(1); // Brief pause between jobs
    }
}

echo "Nautilus KB Worker started\n";
Logger::info("Worker process started (PID: " . getmypid() . ")");
processJobs();
