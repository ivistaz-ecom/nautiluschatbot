<?php
// backend/middleware/RateLimiter.php

class RateLimiter {
    /**
     * Simple sliding-window rate limiter stored in a file-based cache.
     * For production, swap the file cache for Redis.
     */
    public static function check(string $key, int $maxRequests, int $windowSeconds = 60): void {
        $cacheDir = __DIR__ . '/../cache';
        if (!is_dir($cacheDir)) mkdir($cacheDir, 0755, true);

        $file    = $cacheDir . '/' . md5($key) . '.json';
        $now     = time();
        $hits    = [];

        if (file_exists($file)) {
            $data = json_decode(file_get_contents($file), true) ?? [];
            // Keep only hits within window
            $hits = array_filter($data, fn($t) => $t > $now - $windowSeconds);
        }

        if (count($hits) >= $maxRequests) {
            header('Retry-After: ' . $windowSeconds);
            Response::error('Too many requests. Please slow down.', 429);
            exit;
        }

        $hits[] = $now;
        file_put_contents($file, json_encode(array_values($hits)), LOCK_EX);
    }
}
