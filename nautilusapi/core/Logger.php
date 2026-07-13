<?php
// backend/core/Logger.php

class Logger {
    private static function write(string $level, string $message): void {
        $cfg = require __DIR__ . '/../config/config.php';
        $logFile = $cfg['app']['log_file'];
        $dir = dirname($logFile);
        if (!is_dir($dir)) mkdir($dir, 0755, true);

        $line = sprintf("[%s] [%s] %s\n", date('Y-m-d H:i:s'), strtoupper($level), $message);
        file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
    }

    public static function info(string $message): void  { self::write('info', $message); }
    public static function error(string $message): void { self::write('error', $message); }
    public static function warn(string $message): void  { self::write('warn', $message); }
    public static function debug(string $message): void {
        $cfg = require __DIR__ . '/../config/config.php';
        if ($cfg['app']['debug']) self::write('debug', $message);
    }
}
