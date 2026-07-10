<?php
// backend/core/Response.php

class Response {
    public static function json(mixed $data, int $status = 200): void {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public static function success(mixed $data = null, string $message = 'OK', int $status = 200): void {
        self::json(['success' => true, 'message' => $message, 'data' => $data], $status);
    }

    public static function error(string $message, int $status = 400, ?array $errors = null): void {
        $body = ['success' => false, 'message' => $message];
        if ($errors) $body['errors'] = $errors;
        self::json($body, $status);
    }

    public static function paginated(array $items, int $total, int $page, int $perPage): void {
        self::json([
            'success' => true,
            'data'    => $items,
            'meta'    => [
                'total'        => $total,
                'page'         => $page,
                'per_page'     => $perPage,
                'total_pages'  => (int) ceil($total / $perPage),
            ]
        ]);
    }
}
