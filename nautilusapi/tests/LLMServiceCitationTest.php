<?php
require_once __DIR__ . '/../services/LLMService.php';

$chunks = [
    [
        'document_id' => 10,
        'title' => 'Safety Management Manual',
        'page_number' => 49,
        'content' => 'Verification procedure',
        'mime_type' => 'application/pdf',
    ],
    [
        'document_id' => 11,
        'title' => 'ISM Code',
        'page_number' => 18,
        'content' => 'Safety management responsibilities',
        'mime_type' => 'application/pdf',
    ],
];

$result = LLMService::resolveSourcesFromIds([1], $chunks);

if (!is_array($result) || count($result) !== 1) {
    fwrite(STDERR, "Expected one cited source\n");
    exit(1);
}

$source = $result[0];
if (($source['fileName'] ?? null) !== 'ISM Code' || ($source['pageNumber'] ?? null) !== 18) {
    fwrite(STDERR, "Expected source metadata from the cited chunk, got: " . json_encode($source) . "\n");
    exit(1);
}

echo "Citation mapping test passed\n";
