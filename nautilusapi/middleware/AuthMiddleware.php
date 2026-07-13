<?php
// backend/middleware/AuthMiddleware.php

class AuthMiddleware {

    /**
     * Require a valid JWT. Returns the user array or halts.
     */
    public static function require(): array {
        return self::requireToken(Request::bearerToken());
    }

    /**
     * Validate a JWT string (Bearer header or ?token= for inline file viewing).
     */
    public static function requireToken(?string $jwt): array {
        if (!$jwt) {
            Response::error('Authentication required', 401);
            exit;
        }

        $payload = JWT::verify($jwt);
        if (!$payload) {
            Response::error('Invalid or expired token', 401);
            exit;
        }

        $sessionToken = $payload['token'] ?? '';
        if ($sessionToken === '') {
            Response::error('Invalid or expired token', 401);
            exit;
        }

        $row = Database::queryOne(
            'SELECT u.id, u.name, u.email, u.role, u.is_active
             FROM api_tokens t
             JOIN users u ON u.id = t.user_id
             WHERE t.token = ? AND t.expires_at > NOW()',
            [$sessionToken]
        );

        if (!$row || !$row['is_active']) {
            Response::error('Authentication required', 401);
            exit;
        }

        Database::execute('UPDATE api_tokens SET last_used_at = NOW() WHERE token = ?', [$sessionToken]);

        return $row;
    }

    /**
     * Require admin role.
     */
    public static function requireAdmin(): array {
        $user = self::require();
        if ($user['role'] !== 'admin') {
            Response::error('Forbidden: admin only', 403);
            exit;
        }
        return $user;
    }
}
