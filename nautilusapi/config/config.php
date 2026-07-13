<?php
// backend/config/config.php

require_once __DIR__ . '/../core/Env.php';
Env::load(__DIR__ . '/../.env');

return [
    'db' => [
        'host'    => getenv('DB_HOST') ?: 'localhost',
        'port'    => getenv('DB_PORT') ?: '3306',
        'name'    => getenv('DB_NAME') ?: '',
        'user'    => getenv('DB_USER') ?: '',
        'pass'    => getenv('DB_PASS') ?: '',
        'charset' => 'utf8mb4',
    ],

    'jwt' => [
        'secret' => getenv('JWT_SECRET') ?: '',
        'expiry' => 7 * 24 * 3600, // 7 days in seconds
    ],

    'app' => [
        'env'           => getenv('APP_ENV') ?: 'production',
        'url'           => getenv('APP_URL') ?: '',
        'debug'         => getenv('APP_DEBUG') === 'true',
        'upload_dir'    => getenv('UPLOAD_DIR') ?: __DIR__ . '/../uploads',
        'max_upload_mb' => 50,
        'log_file'      => __DIR__ . '/../logs/app.log',
    ],

    'llm' => [
        'provider' => getenv('LLM_PROVIDER') ?: 'claude', // claude | openai | gemini
        'api_key'  => getenv('LLM_API_KEY') ?: '',
        'model'    => [
            'claude' => 'claude-sonnet-4-6',
            'openai' => 'gpt-4o',
            'gemini' => 'gemini-1.5-pro',
        ],
        'max_tokens'     => 1024,
        'context_chunks' => 8,
        'chunk_size'     => 500,   // words per chunk
        'chunk_overlap'  => 50,    // words of overlap
    ],

    'mail' => [
        'driver'    => getenv('MAIL_DRIVER') ?: 'smtp',
        'host'      => getenv('MAIL_HOST') ?: '',
        'port'      => (int) (getenv('MAIL_PORT') ?: 587),
        'username'  => getenv('MAIL_USER') ?: '',
        'password'  => getenv('MAIL_PASS') ?: '',
        'from'      => getenv('MAIL_FROM') ?: 'noreply@nautilusshipping.com',
        'from_name' => 'Nautilus Shipping KB',
    ],

    'rate_limit' => [
        'chat_per_minute' => 10,
    ],

    'faq' => [
        'cache_threshold' => 3, // times asked before serving cached answer
    ],
];
