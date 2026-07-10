<?php
// backend/core/Request.php

class Request {
    private static ?array $body = null;

    public static function body(): array {
        if (self::$body === null) {
            $raw = file_get_contents('php://input');
            self::$body = json_decode($raw, true) ?? [];
        }
        return self::$body;
    }

    public static function input(string $key, mixed $default = null): mixed {
        return self::body()[$key] ?? $_GET[$key] ?? $_POST[$key] ?? $default;
    }

    public static function get(string $key, mixed $default = null): mixed {
        return $_GET[$key] ?? $default;
    }

    public static function post(string $key, mixed $default = null): mixed {
        $body = self::body();
        return $body[$key] ?? $_POST[$key] ?? $default;
    }

    public static function file(string $key): ?array {
        return $_FILES[$key] ?? null;
    }

    public static function method(): string {
        return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    }

    public static function header(string $name): ?string {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        return $_SERVER[$key] ?? null;
    }

    public static function bearerToken(): ?string {
        $auth = $_SERVER['HTTP_AUTHORIZATION']
            ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
            ?? '';

        if ($auth === '' && function_exists('apache_request_headers')) {
            $headers = apache_request_headers();
            $auth    = $headers['Authorization'] ?? $headers['authorization'] ?? '';
        }

        if (str_starts_with($auth, 'Bearer ')) {
            return substr($auth, 7);
        }
        return null;
    }

    public static function ip(): string {
        return $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '';
    }

    public static function origin(): string {
        return $_SERVER['HTTP_ORIGIN'] ?? '';
    }

    public static function paginate(int $defaultPerPage = 20): array {
        $page    = max(1, (int) ($_GET['page'] ?? 1));
        $perPage = min(100, max(5, (int) ($_GET['per_page'] ?? $defaultPerPage)));
        $offset  = ($page - 1) * $perPage;
        return compact('page', 'perPage', 'offset');
    }

    public static function validate(array $rules): array {
        $data   = array_merge(self::body(), $_GET, $_POST);
        $errors = [];

        foreach ($rules as $field => $rule) {
            $parts    = explode('|', $rule);
            $value    = $data[$field] ?? null;

            foreach ($parts as $r) {
                if ($r === 'required' && ($value === null || $value === '')) {
                    $errors[$field][] = "$field is required";
                }
                if (str_starts_with($r, 'min:')) {
                    $min = (int) substr($r, 4);
                    if (is_string($value) && strlen($value) < $min)
                        $errors[$field][] = "$field must be at least $min characters";
                }
                if (str_starts_with($r, 'max:')) {
                    $max = (int) substr($r, 4);
                    if (is_string($value) && strlen($value) > $max)
                        $errors[$field][] = "$field must not exceed $max characters";
                }
                if ($r === 'email' && $value && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
                    $errors[$field][] = "$field must be a valid email address";
                }
                if ($r === 'numeric' && $value !== null && !is_numeric($value)) {
                    $errors[$field][] = "$field must be numeric";
                }
            }
        }

        return $errors;
    }
}
