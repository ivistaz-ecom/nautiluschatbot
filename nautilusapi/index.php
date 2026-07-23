<?php
// backend/index.php — Main entry point
// All requests routed through this file via .htaccess

declare(strict_types=1);
error_reporting(E_ALL);
ini_set('display_errors', '0'); // Never expose errors to client

$baseDir = __DIR__;

// Register handlers before any requires so boot fatals still return JSON.
set_exception_handler(function (Throwable $e) {
    if (class_exists('Logger', false)) {
        try {
            Logger::error('Unhandled exception: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
        } catch (Throwable) {
            // Logger may fail if config/logs are unavailable — still return JSON below.
        }
    }
    $msg = $e->getMessage() !== '' ? $e->getMessage() : 'Internal server error';
    if (class_exists('Response', false)) {
        Response::error($msg, 500);
        return;
    }
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['success' => false, 'message' => $msg]);
});

register_shutdown_function(function () {
    $error = error_get_last();
    if (!$error || !in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        return;
    }
    if (class_exists('Logger', false)) {
        try {
            Logger::error('Fatal: ' . ($error['message'] ?? '') . ' in ' . ($error['file'] ?? '') . ':' . ($error['line'] ?? ''));
        } catch (Throwable) {
            // ignore
        }
    }
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    // Avoid double output if an earlier handler already wrote a body.
    if (ob_get_length() === false || ob_get_length() === 0) {
        $msg = 'Internal server error';
        // Include fatal message so Hostinger deploys are debuggable without SSH logs.
        if (!empty($error['message'])) {
            $msg = $error['message'];
        }
        echo json_encode(['success' => false, 'message' => $msg]);
    }
});

// ── Autoload core classes ──────────────────────────────────────────
require_once $baseDir . '/core/Database.php';
require_once $baseDir . '/core/Response.php';
require_once $baseDir . '/core/Request.php';
require_once $baseDir . '/core/Router.php';
require_once $baseDir . '/core/JWT.php';
require_once $baseDir . '/core/Logger.php';
require_once $baseDir . '/middleware/AuthMiddleware.php';
require_once $baseDir . '/middleware/WhitelistMiddleware.php';
require_once $baseDir . '/middleware/RateLimiter.php';

// ── Controllers ────────────────────────────────────────────────────
require_once $baseDir . '/api/v1/auth/AuthController.php';
require_once $baseDir . '/api/v1/chat/ChatController.php';
require_once $baseDir . '/api/v1/documents/DocumentController.php';
require_once $baseDir . '/api/v1/admin/AdminController.php';
// LLMService is loaded on demand (chat / health/llm) — do not require at boot.

// Apply whitelist + CORS first
WhitelistMiddleware::handle();

// ── Router ─────────────────────────────────────────────────────────
$router = new Router();

// Get method and URI
$method = Request::method();
$uri    = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

// Strip /api/v1 prefix if present
$uri = preg_replace('#^/api/v1#', '', $uri) ?: '/';
$uri = rtrim($uri, '/') ?: '/';

// ── AUTH ──────────────────────────────────────────────────────────
$router->post('/auth/register',        [AuthController::class, 'register']);
$router->post('/auth/login',           [AuthController::class, 'login']);
$router->post('/auth/logout',          [AuthController::class, 'logout']);
$router->post('/auth/verify-email',    [AuthController::class, 'verifyEmail']);
$router->get ('/auth/verify-email',    [AuthController::class, 'verifyEmail']);
$router->post('/auth/forgot-password', [AuthController::class, 'forgotPassword']);
$router->post('/auth/reset-password',  [AuthController::class, 'resetPassword']);
$router->get ('/auth/me',              [AuthController::class, 'me']);

// ── CHAT ──────────────────────────────────────────────────────────
$router->post  ('/chat/ask',                  [ChatController::class, 'ask']);
$router->get   ('/chat/locate-source',        [ChatController::class, 'locateSource']);
$router->get   ('/chat/sessions',             [ChatController::class, 'sessions']);
$router->get   ('/chat/sessions/:id',         [ChatController::class, 'session']);
$router->delete('/chat/sessions/:id',         [ChatController::class, 'deleteSession']);
$router->get   ('/chat/faqs',                 [ChatController::class, 'faqs']);
$router->get   ('/chat/categories',           [ChatController::class, 'categories']);
$router->get   ('/chat/documents',            [ChatController::class, 'documents']);
$router->post  ('/chat/submit-query',         [ChatController::class, 'submitQuery']);
$router->get   ('/chat/documents/:id/file',   [DocumentController::class, 'serveFile']);

// ── DOCUMENTS (Admin) ─────────────────────────────────────────────
$router->get   ('/admin/documents',           [DocumentController::class, 'index']);
$router->post  ('/admin/documents',           [DocumentController::class, 'upload']);
$router->get   ('/admin/documents/:id',       [DocumentController::class, 'show']);
$router->put   ('/admin/documents/:id',       [DocumentController::class, 'update']);
$router->post  ('/admin/documents/:id/update',[DocumentController::class, 'update']);
$router->get   ('/admin/documents/:id/file',  [DocumentController::class, 'serveAdminFile']);
$router->delete('/admin/documents/:id',       [DocumentController::class, 'delete']);
$router->post  ('/admin/documents/:id/reparse',     [DocumentController::class,'reparse']);
$router->post  ('/admin/documents/:id/ingest-pages',[DocumentController::class,'ingestPages']);

// ── ADMIN ─────────────────────────────────────────────────────────
$router->get   ('/admin/categories',          [AdminController::class, 'categoriesIndex']);
$router->post  ('/admin/categories',          [AdminController::class, 'categoriesCreate']);
$router->put   ('/admin/categories/:id',      [AdminController::class, 'categoriesUpdate']);
$router->delete('/admin/categories/:id',      [AdminController::class, 'categoriesDelete']);

$router->get   ('/admin/users',               [AdminController::class, 'usersIndex']);
$router->get   ('/admin/users/:id',           [AdminController::class, 'usersShow']);
$router->put   ('/admin/users/:id/toggle',    [AdminController::class, 'usersToggle']);

$router->get   ('/admin/whitelist',           [AdminController::class, 'whitelistIndex']);
$router->post  ('/admin/whitelist',           [AdminController::class, 'whitelistCreate']);
$router->delete('/admin/whitelist/:id',       [AdminController::class, 'whitelistDelete']);
$router->put   ('/admin/whitelist/:id/toggle',[AdminController::class, 'whitelistToggle']);

$router->get   ('/admin/queries',             [AdminController::class, 'queriesIndex']);
$router->post  ('/admin/queries/:id/answer',  [AdminController::class, 'queriesAnswer']);
$router->delete('/admin/queries/:id',         [AdminController::class, 'queriesDelete']);
$router->post  ('/admin/queries/:id/delete',  [AdminController::class, 'queriesDelete']);
$router->get   ('/admin/questions',           [AdminController::class, 'allQuestions']);

$router->get   ('/admin/metrics',             [AdminController::class, 'metrics']);

// ── Health check ──────────────────────────────────────────────────
$router->get('/health', function() {
    Response::success(['status' => 'ok', 'timestamp' => time()]);
});

$router->get('/health/db', function() {
    $cfgPath = __DIR__ . '/config/config.php';
    if (!is_readable($cfgPath)) {
        Response::error('config/config.php is missing on the server', 503);
        return;
    }

    try {
        Database::getInstance()->query('SELECT 1 AS ok');
        Response::success(['database' => 'connected']);
    } catch (Throwable $e) {
        $cfg    = require $cfgPath;
        $detail = !empty($cfg['app']['debug']) ? $e->getMessage() : 'Database connection failed';
        Response::error($detail, 503);
    }
});

$router->get('/health/llm', function() {
    $cfgPath = __DIR__ . '/config/config.php';
    if (!is_readable($cfgPath)) {
        Response::error('config/config.php is missing on the server', 503);
        return;
    }

    try {
        require_once __DIR__ . '/services/LLMService.php';
        $result = LLMService::ping();
        Response::success(['llm' => 'connected', 'provider' => $result['provider'], 'model' => $result['model']]);
    } catch (Throwable $e) {
        $cfg    = require $cfgPath;
        $detail = !empty($cfg['app']['debug']) ? $e->getMessage() : 'LLM API connection failed';
        Response::error($detail, 503);
    }
});

$router->get('/health/document-file', function() {
    Response::success(['document_file_route' => true]);
});

$router->get('/health/document-update', function() {
    Response::success(['document_update_route' => true]);
});

// ── Dispatch ──────────────────────────────────────────────────────
$router->dispatch($method, $uri);
