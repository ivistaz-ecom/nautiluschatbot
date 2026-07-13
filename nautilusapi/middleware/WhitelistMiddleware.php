<?php
// backend/middleware/WhitelistMiddleware.php

class WhitelistMiddleware {

    public static function handle(): void {
        $origin = Request::origin();

        // Apply CORS headers
        if ($origin) {
            if (self::isAllowed($origin)) {
                header("Access-Control-Allow-Origin: $origin");
                header("Access-Control-Allow-Credentials: true");
            } else {
                // Still need to send CORS headers even on rejection for preflight
                header("Access-Control-Allow-Origin: null");
            }
        }

        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
        header('Access-Control-Max-Age: 86400');

        // Handle preflight
        if (Request::method() === 'OPTIONS') {
            http_response_code(204);
            exit;
        }

        // Block requests from unlisted origins (skip check for same-origin / no origin)
        if ($origin) {
            try {
                if (!self::isAllowed($origin)) {
                    Response::error('Origin not whitelisted', 403);
                    exit;
                }
            } catch (Throwable $e) {
                Response::error('Database connection failed', 503);
                exit;
            }
        }
    }

    private static function isAllowed(string $origin): bool {
        $candidates = self::originVariants($origin);

        foreach ($candidates as $candidate) {
            $row = Database::queryOne(
                'SELECT id FROM whitelisted_urls WHERE origin = ? AND is_active = 1 LIMIT 1',
                [$candidate]
            );
            if ($row !== null) {
                return true;
            }
        }

        return false;
    }

    /** Treat localhost and 127.0.0.1 as equivalent for the same port. */
    private static function originVariants(string $origin): array {
        $variants = [$origin];

        $parsed = parse_url($origin);
        if (!$parsed || empty($parsed['scheme']) || empty($parsed['host'])) {
            return $variants;
        }

        $port = isset($parsed['port']) ? ':' . $parsed['port'] : '';
        $hosts = [];

        if ($parsed['host'] === 'localhost') {
            $hosts[] = '127.0.0.1';
        } elseif ($parsed['host'] === '127.0.0.1') {
            $hosts[] = 'localhost';
        }

        foreach ($hosts as $host) {
            $variants[] = $parsed['scheme'] . '://' . $host . $port;
        }

        return array_values(array_unique($variants));
    }
}
