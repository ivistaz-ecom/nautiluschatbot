<?php
/**
 * Standalone document metadata update endpoint.
 *
 * Hostinger path (correct):
 *   public_html/api/v1/document-update.php
 *
 * Upload into the folder that already has admin / auth / chat / documents.
 * Do NOT create a new folder. Do NOT put this inside documents/.
 *
 * Filename must be: document-update.php  (not document_upload.php)
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

/**
 * Find the app root that contains /core/Database.php
 * (on Hostinger that is usually public_html, while this file lives in public_html/api/v1).
 */
function nautilusFindAppRoot(string $startDir): ?string {
    $dir = $startDir;
    for ($i = 0; $i < 6; $i++) {
        if (is_file($dir . '/core/Database.php')) {
            return $dir;
        }
        $parent = dirname($dir);
        if ($parent === $dir) {
            break;
        }
        $dir = $parent;
    }
    return null;
}

$baseDir = nautilusFindAppRoot(__DIR__);
if ($baseDir === null) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Could not find core/Database.php. Upload document-update.php to public_html/api/v1/.',
    ]);
    exit;
}

require_once $baseDir . '/core/Database.php';
require_once $baseDir . '/core/Response.php';
require_once $baseDir . '/core/Request.php';
require_once $baseDir . '/core/JWT.php';
require_once $baseDir . '/middleware/AuthMiddleware.php';

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if (!in_array($method, ['POST', 'PUT'], true)) {
    Response::error('Method not allowed', 405);
    exit;
}

AuthMiddleware::requireAdmin();

$id = (int) ($_GET['id'] ?? 0);
if ($id <= 0) {
    Response::error('Document id is required (?id=)', 400);
    exit;
}

if (!Database::queryOne('SELECT id FROM documents WHERE id = ?', [$id])) {
    Response::error('Document not found', 404);
    exit;
}

$title = trim((string) (Request::input('title') ?? ''));
$originalFilename = trim((string) (Request::input('original_filename') ?? ''));
$categoryId = (int) (Request::input('category_id') ?? 0);

if ($title === '') {
    Response::error('Document name is required', 422);
    exit;
}

if ($categoryId <= 0 || !Database::queryOne('SELECT id FROM categories WHERE id = ?', [$categoryId])) {
    Response::error('Invalid category', 422);
    exit;
}

if (strlen($title) > 255) {
    Response::error('Document name must not exceed 255 characters', 422);
    exit;
}

if ($originalFilename !== '' && strlen($originalFilename) > 255) {
    Response::error('File name must not exceed 255 characters', 422);
    exit;
}

if ($originalFilename !== '') {
    $originalFilename = preg_replace('/[^\w\s.\-()]/', '_', $originalFilename);
    Database::execute(
        'UPDATE documents SET title = ?, category_id = ?, original_filename = ?, updated_at = NOW() WHERE id = ?',
        [$title, $categoryId, $originalFilename, $id]
    );
} else {
    Database::execute(
        'UPDATE documents SET title = ?, category_id = ?, updated_at = NOW() WHERE id = ?',
        [$title, $categoryId, $id]
    );
}

$doc = Database::queryOne(
    'SELECT d.*, c.name AS category_name FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.id = ?',
    [$id]
);

Response::success($doc, 'Document updated');
