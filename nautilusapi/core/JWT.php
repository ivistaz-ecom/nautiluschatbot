<?php
// backend/core/JWT.php

class JWT {
    private static function getSecret(): string {
        $cfg = require __DIR__ . '/../config/config.php';
        return $cfg['jwt']['secret'];
    }

    private static function base64UrlEncode(string $data): string {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $data): string {
        return base64_decode(strtr($data, '-_', '+/') . str_repeat('=', 3 - (3 + strlen($data)) % 4));
    }

    public static function generate(array $payload): string {
        $cfg = require __DIR__ . '/../config/config.php';
        $payload['iat'] = time();
        $payload['exp'] = time() + $cfg['jwt']['expiry'];

        $header  = self::base64UrlEncode(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));
        $body    = self::base64UrlEncode(json_encode($payload));
        $sig     = self::base64UrlEncode(hash_hmac('sha256', "$header.$body", self::getSecret(), true));

        return "$header.$body.$sig";
    }

    public static function verify(string $token): ?array {
        $parts = explode('.', $token);
        if (count($parts) !== 3) return null;

        [$header, $body, $sig] = $parts;
        $expected = self::base64UrlEncode(hash_hmac('sha256', "$header.$body", self::getSecret(), true));

        if (!hash_equals($expected, $sig)) return null;

        $payload = json_decode(self::base64UrlDecode($body), true);
        if (!$payload || $payload['exp'] < time()) return null;

        return $payload;
    }
}
