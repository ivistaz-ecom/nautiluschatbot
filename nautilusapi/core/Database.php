<?php
// backend/core/Database.php

class Database {
    private static ?PDO $instance = null;

    public static function getInstance(): PDO {
        if (self::$instance !== null) {
            return self::$instance;
        }

        $cfgPath = __DIR__ . '/../config/config.php';
        if (!is_readable($cfgPath)) {
            Response::error('config/config.php is missing on the server', 503);
            exit;
        }

        $cfg = require $cfgPath;
        $db  = $cfg['db'];

        $dsn = "mysql:host={$db['host']};port={$db['port']};dbname={$db['name']};charset={$db['charset']}";
        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ];

        try {
            self::$instance = new PDO($dsn, $db['user'], $db['pass'], $options);
        } catch (PDOException $e) {
            if (class_exists('Logger', false)) {
                try {
                    Logger::error('DB connection failed: ' . $e->getMessage());
                } catch (Throwable) {
                    // Ignore logging failures.
                }
            }

            $detail = !empty($cfg['app']['debug']) ? $e->getMessage() : 'Database connection failed';
            Response::error($detail, 503);
            exit;
        }

        return self::$instance;
    }

    public static function query(string $sql, array $params = []): array {
        $stmt = self::getInstance()->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public static function queryOne(string $sql, array $params = []): ?array {
        $stmt = self::getInstance()->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public static function execute(string $sql, array $params = []): int {
        $stmt = self::getInstance()->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }

    public static function insert(string $sql, array $params = []): string {
        $stmt = self::getInstance()->prepare($sql);
        $stmt->execute($params);
        return self::getInstance()->lastInsertId();
    }

    public static function beginTransaction(): void {
        self::getInstance()->beginTransaction();
    }

    public static function commit(): void {
        self::getInstance()->commit();
    }

    public static function rollback(): void {
        self::getInstance()->rollBack();
    }
}
