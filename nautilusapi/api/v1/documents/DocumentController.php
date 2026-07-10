<?php
// backend/api/v1/documents/DocumentController.php

require_once __DIR__ . '/../../../core/Logger.php';
require_once __DIR__ . '/../../../middleware/AuthMiddleware.php';
require_once __DIR__ . '/../../../services/DocumentParser.php';

class DocumentController {

    public function upload(array $params = []): void {
        $admin = AuthMiddleware::requireAdmin();
        $cfg   = require __DIR__ . '/../../../config/config.php';

        $file       = Request::file('file');
        $categoryId = (int) (Request::post('category_id') ?? 0);
        $title      = trim(Request::post('title') ?? '');

        $fileName = is_array($file) ? ($file['name'] ?? null) : null;
        $fileSize = is_array($file) ? ($file['size'] ?? null) : null;
        $fileMime = is_array($file) ? ($file['type'] ?? null) : null;

        Logger::info('Uploading PDF: ' . json_encode([
            'filename' => $fileName,
            'mime' => $fileMime,
            'size' => $fileSize,
            'category_id' => $categoryId,
        ]));

        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            Response::error('File upload failed or no file provided', 400);
            return;
        }

        // Validate MIME (some hosts report DOCX as application/zip)
        $mime = mime_content_type($file['tmp_name']);
        $ext  = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if ($ext === 'docx' && in_array($mime, ['application/zip', 'application/octet-stream'], true)) {
            $mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }
        $allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (!in_array($mime, $allowed)) {
            Response::error('Only PDF and DOCX files are allowed', 400);
            return;
        }

        // Validate size
        $maxBytes = $cfg['app']['max_upload_mb'] * 1024 * 1024;
        if ($file['size'] > $maxBytes) {
            Response::error("File exceeds maximum size of {$cfg['app']['max_upload_mb']}MB", 400);
            return;
        }

        // Validate category
        if (!Database::queryOne('SELECT id FROM categories WHERE id = ?', [$categoryId])) {
            Response::error('Invalid category', 400);
            return;
        }

        // Build storage path
        $uploadDir = rtrim($cfg['app']['upload_dir'], '/');
        if (!is_dir($uploadDir)) mkdir($uploadDir, 0755, true);

        $ext      = $mime === 'application/pdf' ? 'pdf' : 'docx';
        $filename = uniqid('doc_', true) . '.' . $ext;
        $destPath = rtrim($uploadDir, '/') . '/' . $filename;

        if (!move_uploaded_file($file['tmp_name'], $destPath)) {
            Response::error('Failed to save uploaded file', 500);
            return;
        }

        // Store canonical absolute path for reliable file serving later
        $storedPath = realpath($destPath) ?: $destPath;

        if (!$title) {
            $title = pathinfo($file['name'], PATHINFO_FILENAME);
        }

        // Insert document record
        $docId = Database::insert(
            'INSERT INTO documents (category_id, title, original_filename, storage_path, mime_type, file_size, status, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
            [$categoryId, $title, $file['name'], $storedPath, $mime, $file['size'], 'pending', $admin['id']]
        );

        // Queue parsing job
        Database::insert(
            'INSERT INTO document_jobs (document_id, status) VALUES (?, ?)',
            [$docId, 'queued']
        );

        // Parse immediately so documents are searchable without a background worker
        $this->parseDocument((int) $docId, $storedPath, $mime);

        $doc = Database::queryOne(
            'SELECT status, error_message, page_count FROM documents WHERE id = ?',
            [$docId]
        );

        $status  = $doc['status'] ?? 'pending';
        $message = match ($status) {
            'ready' => 'Document uploaded and indexed successfully.',
            'error' => 'Document uploaded but parsing failed: ' . ($doc['error_message'] ?? 'unknown error'),
            default => 'Document uploaded. Parsing in progress.',
        };

        Response::success(
            [
                'document_id' => (int) $docId,
                'status'      => $status,
                'page_count'  => isset($doc['page_count']) ? (int) $doc['page_count'] : null,
                'error'       => $doc['error_message'] ?? null,
            ],
            $message,
            201
        );
    }

    public function index(array $params = []): void {
        AuthMiddleware::requireAdmin();
        ['page' => $page, 'perPage' => $perPage, 'offset' => $offset] = Request::paginate();

        $categoryId = Request::get('category_id');
        $status     = Request::get('status');
        $search     = Request::get('search');

        $where  = ['1=1'];
        $binds  = [];

        if ($categoryId) { $where[] = 'd.category_id = ?'; $binds[] = (int) $categoryId; }
        if ($status)     { $where[] = 'd.status = ?';       $binds[] = $status; }
        if ($search)     { $where[] = 'd.title LIKE ?';     $binds[] = "%$search%"; }

        $whereStr = implode(' AND ', $where);

        $total = Database::queryOne(
            "SELECT COUNT(*) AS c FROM documents d WHERE $whereStr",
            $binds
        )['c'];

        $rows = Database::query(
            "SELECT d.*, c.name AS category_name, u.name AS uploaded_by_name
             FROM documents d
             JOIN categories c ON c.id = d.category_id
             JOIN users u ON u.id = d.uploaded_by
             WHERE $whereStr
             ORDER BY d.created_at DESC
             LIMIT ? OFFSET ?",
            array_merge($binds, [$perPage, $offset])
        );

        $cfg = require __DIR__ . '/../../../config/config.php';
        foreach ($rows as &$row) {
            $row['file_on_disk'] = $this->resolveDocumentPath(
                $row['storage_path'],
                $cfg['app']['upload_dir']
            ) !== null;
        }
        unset($row);

        Response::paginated($rows, (int) $total, $page, $perPage);
    }

    /** Stream a document file for authenticated chat users (inline PDF/DOCX view). */
    public function serveFile(array $params): void {
        $jwt = Request::bearerToken() ?? Request::get('token');
        AuthMiddleware::requireToken(is_string($jwt) ? $jwt : null);
        $cfg = require __DIR__ . '/../../../config/config.php';

        $id  = (int) ($params['id'] ?? 0);
        $doc = Database::queryOne(
            "SELECT storage_path, mime_type, original_filename, status FROM documents WHERE id = ? AND status = 'ready'",
            [$id]
        );

        if (!$doc) {
            Response::error('Document not found', 404);
            return;
        }

        $path = $this->resolveDocumentPath($doc['storage_path'], $cfg['app']['upload_dir']);
        if (!$path) {
            Logger::warn("Document file missing or unreadable: id=$id path={$doc['storage_path']}");
            Response::error(
                'PDF file missing on server. Re-upload the document in Admin → Documents.',
                404
            );
            return;
        }

        $filename = preg_replace('/[^\w\s.\-()]/', '_', $doc['original_filename'] ?? 'document');
        $isPdf    = ($doc['mime_type'] ?? '') === 'application/pdf';

        if ($isPdf) {
            header('Content-Type: application/pdf');
            header('Content-Disposition: inline');
        } else {
            header('Content-Type: ' . $doc['mime_type']);
            header('Content-Disposition: inline; filename="' . $filename . '"');
        }
        header('Content-Length: ' . (string) filesize($path));
        header('Cache-Control: private, max-age=3600');
        header('Accept-Ranges: bytes');
        readfile($path);
        exit;
    }

    /** Resolve a stored path to a readable file under uploads/. */
    private function resolveDocumentPath(string $storagePath, string $uploadDir): ?string {
        $normalized = str_replace('/config/../', '/', $storagePath);
        $basename   = basename($storagePath);

        $candidates = array_unique(array_filter([
            $storagePath,
            $normalized,
            rtrim($uploadDir, '/') . '/' . $basename,
        ]));

        foreach ($candidates as $candidate) {
            $resolved = realpath($candidate);
            if (!$resolved || !is_file($resolved) || !is_readable($resolved)) {
                continue;
            }

            $ext = strtolower(pathinfo($resolved, PATHINFO_EXTENSION));
            if (!in_array($ext, ['pdf', 'docx'], true)) {
                continue;
            }

            // Must be inside an uploads folder (security boundary)
            if (!str_contains($resolved, DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR)) {
                continue;
            }

            return $resolved;
        }

        return null;
    }

    public function show(array $params): void {
        AuthMiddleware::requireAdmin();
        $id  = (int) ($params['id'] ?? 0);
        $doc = Database::queryOne(
            'SELECT d.*, c.name AS category_name FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.id = ?',
            [$id]
        );

        if (!$doc) {
            Response::error('Document not found', 404);
            return;
        }

        $chunkCount = Database::queryOne(
            'SELECT COUNT(*) AS c FROM document_chunks WHERE document_id = ?',
            [$id]
        )['c'];

        $doc['chunk_count'] = (int) $chunkCount;
        Response::success($doc);
    }

    public function delete(array $params): void {
        AuthMiddleware::requireAdmin();
        $id  = (int) ($params['id'] ?? 0);
        $doc = Database::queryOne('SELECT storage_path FROM documents WHERE id = ?', [$id]);

        if (!$doc) {
            Response::error('Document not found', 404);
            return;
        }

        Database::execute('DELETE FROM documents WHERE id = ?', [$id]);

        // Delete physical file
        if (file_exists($doc['storage_path'])) {
            unlink($doc['storage_path']);
        }

        Response::success(null, 'Document deleted');
    }

    public function reparse(array $params): void {
        AuthMiddleware::requireAdmin();
        $id  = (int) ($params['id'] ?? 0);
        $doc = Database::queryOne('SELECT id, storage_path, mime_type FROM documents WHERE id = ?', [$id]);

        if (!$doc) {
            Response::error('Document not found', 404);
            return;
        }

        // Clear existing chunks
        Database::execute('DELETE FROM document_chunks WHERE document_id = ?', [$id]);
        Database::execute("UPDATE documents SET status = 'pending', page_count = NULL WHERE id = ?", [$id]);

        $this->parseDocument((int) $doc['id'], $doc['storage_path'], $doc['mime_type']);

        Response::success(null, 'Re-parse triggered');
    }

    // ── Internal parse ─────────────────────────────────────────────

    private function parseDocument(int $docId, string $path, string $mime): void {
        try {
            Database::execute("UPDATE documents SET status = 'processing' WHERE id = ?", [$docId]);
            Database::execute("UPDATE document_jobs SET status = 'processing', attempts = attempts + 1 WHERE document_id = ?", [$docId]);

            Logger::info('Starting PDF parse ' . json_encode(['file' => $path]));
            $parser = new DocumentParser();
            $pages  = $mime === 'application/pdf'
                ? $parser->parsePdf($path)
                : $parser->parseDocx($path);

            Logger::info('PDF parsed ' . json_encode(['pages_detected' => count($pages)]));
            foreach ($pages as $pageNumber => $pageText) {
                Logger::info('Parsed page ' . json_encode([
                    'page' => $pageNumber,
                    'length' => strlen($pageText),
                    'preview' => substr(trim($pageText), 0, 150),
                ]));
            }

            Logger::info("[DOC_PARSE] Document ID $docId: extracted " . count($pages) . " pages from " . basename($path));

            $this->assertExtractedText($pages);

            $cfg = require __DIR__ . '/../../../config/config.php';
            $chunkSize    = $cfg['llm']['chunk_size'];
            $chunkOverlap = $cfg['llm']['chunk_overlap'];
            $chunkCount   = 0;

            Logger::info('[DOC_PARSE] pages_detected=' . count($pages));
            //sibi
            foreach ($pages as $pageNum => $text) {

    Logger::info(sprintf(
        '[PAGE_CHECK] page=%d length=%d first100=%s',
        $pageNum,
        strlen($text),
        substr(str_replace(["\r","\n"], ' ', $text), 0, 100)
    ));

    if (!trim($text)) {
        Logger::info("[PAGE_CHECK] page $pageNum skipped because EMPTY");
        continue;
    }

    if (DocumentParser::isTableOfContentsPage($text)) {
        Logger::info("[PAGE_CHECK] page $pageNum skipped because TOC");
        continue;
    }
    //sibi

                // Chunk within the page; every chunk reuses the same page_number metadata.
                $chunks = $parser->chunkText($text, $chunkSize, $chunkOverlap);
                Logger::info('Creating chunks ' . json_encode(['page' => $pageNum, 'chunk_count' => count($chunks)]));
                foreach ($chunks as $idx => $chunk) {
                    // Skip individual TOC-style chunks that slipped through on mixed pages.
                    if (DocumentParser::isTableOfContentsChunk($chunk)) {
                        continue;
                    }
                    Logger::info('Saving chunk ' . json_encode(['page_number' => $pageNum, 'length' => strlen($chunk)]));
                    Database::insert(
                        'INSERT INTO document_chunks (document_id, page_number, chunk_index, content) VALUES (?,?,?,?)',
                        [$docId, $pageNum, $idx, $chunk]
                    );
                    $chunkCount++;
                }
            }

            // Extract keywords from last 10% of pages (index/annexure)
            $keywords = $parser->extractKeywords($pages);

            Logger::info('Ingestion completed ' . json_encode(['pages' => count($pages), 'chunks' => $chunkCount]));
            Logger::info("[DOC_PARSE] Document ID $docId: created $chunkCount chunks from " . count($pages) . " extracted pages");

            // page_count reflects total PDF pages (including blanks skipped above)
            Database::execute(
                "UPDATE documents SET status = 'ready', page_count = ?, keywords = ? WHERE id = ?",
                [count($pages), $keywords, $docId]
            );
            Database::execute("UPDATE document_jobs SET status = 'done' WHERE document_id = ?", [$docId]);

        } catch (Exception $e) {
            Logger::error("Document parse failed (ID $docId): " . $e->getMessage());
            Database::execute(
                "UPDATE documents SET status = 'error', error_message = ? WHERE id = ?",
                [$e->getMessage(), $docId]
            );
            Database::execute(
                "UPDATE document_jobs SET status = 'failed', error_message = ? WHERE document_id = ?",
                [$e->getMessage(), $docId]
            );
        }
    }

    private function assertExtractedText(array $pages): void {
        $placeholders = [
            'No text content extracted',
            'No text extracted',
            'No extractable text found (may be a scanned PDF)',
        ];

        $totalChars = 0;
        foreach ($pages as $text) {
            $trimmed = trim($text);
            // Blank pages are kept for index fidelity; they don't count as extraction failures.
            if ($trimmed === '') {
                continue;
            }
            if (in_array($trimmed, $placeholders, true)) {
                throw new RuntimeException(
                    'Could not extract readable text. The file may be a scanned/image PDF — please upload a text-based PDF or DOCX.'
                );
            }
            $totalChars += strlen($trimmed);
        }

        if ($totalChars < 50) {
            throw new RuntimeException('Could not extract enough text from the document to index it.');
        }
    }
}
