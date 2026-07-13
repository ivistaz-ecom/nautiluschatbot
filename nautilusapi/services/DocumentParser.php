<?php
// backend/services/DocumentParser.php

class DocumentParser {

    /**
     * Parse PDF using pdftotext (poppler) CLI or fallback PHP parsing.
     * Returns array: [page_number => text] where keys are 1-based original PDF page numbers.
     * These keys must be preserved when chunking so retrieval can deep-link with #page=N.
     */
    public function parsePdf(string $path): array {
        require_once __DIR__ . '/../core/Logger.php';

        Logger::info('========== PDF PARSER START ==========');
        Logger::info('File : ' . $path);

        $candidates = [];

        if ($this->commandExists('pdftotext')) {
            foreach (['-layout', '-raw', ''] as $mode) {
                try {
                    $pages = $this->runPdftotext($path, $mode);
                    $chars = self::countMeaningfulChars($pages);
                    Logger::info('[PDF_TRY] pdftotext ' . ($mode ?: 'default') . " chars=$chars pages=" . count($pages));
                    $candidates[] = ['label' => 'pdftotext ' . ($mode ?: 'default'), 'pages' => $pages, 'chars' => $chars];
                } catch (Exception $e) {
                    Logger::info('[PDF_TRY] pdftotext ' . ($mode ?: 'default') . ' failed: ' . $e->getMessage());
                }
            }
        }

        try {
            $pages = $this->parsePdfPhp($path);
            $chars = self::countMeaningfulChars($pages);
            Logger::info("[PDF_TRY] PHP parser chars=$chars pages=" . count($pages));
            $candidates[] = ['label' => 'php', 'pages' => $pages, 'chars' => $chars];
        } catch (Exception $e) {
            Logger::info('[PDF_TRY] PHP parser failed: ' . $e->getMessage());
        }

        $best = self::pickBestCandidate($candidates);

        if ($best !== null && $best['chars'] >= 50) {
            Logger::info('[PDF_BEST] Using ' . $best['label'] . ' chars=' . $best['chars']);
            return $best['pages'];
        }

        if ($this->commandExists('pdftoppm') && $this->commandExists('tesseract')) {
            Logger::info('Using OCR fallback');
            try {
                $pages = $this->parsePdfWithOcr($path);
                $chars = self::countMeaningfulChars($pages);
                Logger::info("[PDF_TRY] OCR chars=$chars pages=" . count($pages));
                if ($chars >= 50) {
                    return $pages;
                }
                $candidates[] = ['label' => 'ocr', 'pages' => $pages, 'chars' => $chars];
            } catch (Exception $e) {
                Logger::info('[PDF_TRY] OCR failed: ' . $e->getMessage());
            }
        }

        $best = self::pickBestCandidate($candidates);
        if ($best !== null && $best['chars'] > 0) {
            Logger::info('[PDF_BEST] Using weak result from ' . $best['label'] . ' chars=' . $best['chars']);
            return $best['pages'];
        }

        return [1 => 'No extractable text found (may be a scanned PDF)'];
    }

    /** Count non-whitespace characters across all pages (images are ignored by text extractors). */
    public static function countMeaningfulChars(array $pages): int {
        $total = 0;
        foreach ($pages as $text) {
            $trimmed = trim((string) $text);
            if ($trimmed === '') {
                continue;
            }
            $total += strlen(preg_replace('/\s+/', '', $trimmed));
        }
        return $total;
    }

    /**
     * @param  array<int, array{label: string, pages: array<int, string>, chars: int}> $candidates
     * @return array{label: string, pages: array<int, string>, chars: int}|null
     */
    private static function pickBestCandidate(array $candidates): ?array {
        $best = null;
        foreach ($candidates as $candidate) {
            if ($best === null || $candidate['chars'] > $best['chars']) {
                $best = $candidate;
            }
        }
        return $best;
    }

    /**
     * Run pdftotext with optional flags. Images in the PDF are skipped automatically.
     */
    private function runPdftotext(string $path, string $flags = '-layout'): array {
        $tmpBase = sys_get_temp_dir() . '/nautilus_pdf_' . uniqid();
        $envPath = $this->getShellPath();
        $flagStr = $flags !== '' ? $flags . ' ' : '';
        $cmd     = sprintf(
            'PATH=%s pdftotext %s-enc UTF-8 %s %s.txt 2>/dev/null',
            escapeshellarg($envPath),
            $flagStr,
            escapeshellarg($path),
            escapeshellarg($tmpBase)
        );

        require_once __DIR__ . '/../core/Logger.php';
        Logger::info('[PDF_CMD] ' . $cmd);

        exec($cmd, $out, $code);

        $txtFile = $tmpBase . '.txt';
        if (!file_exists($txtFile)) {
            throw new RuntimeException("pdftotext failed for: $path");
        }

        $text = (string) file_get_contents($txtFile);
        @unlink($txtFile);

        if (trim($text) === '') {
            throw new RuntimeException('pdftotext produced empty output');
        }

        return $this->splitPdftotextPages($text, $path);
    }

    /**
     * Split pdftotext output into 1-based page map aligned with the PDF viewer.
     */
    private function splitPdftotextPages(string $text, string $path): array {
        $rawPages = explode("\f", $text);
        $pages    = [];

        foreach ($rawPages as $i => $page) {
            $pages[$i + 1] = trim($page);
        }

        while (!empty($pages) && end($pages) === '') {
            array_pop($pages);
        }

        if (empty($pages)) {
            throw new RuntimeException('No pages after split');
        }

        $expected = $this->getPdfPageCount($path);
        $got      = count($pages);

        // If form-feed split missed pages, retry with -raw for this caller only when severely short.
        if ($expected !== null && $expected >= 3 && $got < (int) floor($expected * 0.5)) {
            Logger::info("[PDF_SPLIT] page mismatch got=$got expected=$expected for " . basename($path));
        }

        return $pages;
    }

    /**
     * Parse DOCX using PHP ZipArchive + XML parsing (no library needed).
     */
    public function parseDocx(string $path): array {
        $zip = new ZipArchive();
        if ($zip->open($path) !== true) {
            throw new RuntimeException("Cannot open DOCX: $path");
        }

        $xml  = $zip->getFromName('word/document.xml');
        $zip->close();

        if (!$xml) {
            throw new RuntimeException("Cannot read document.xml from DOCX");
        }

        // Strip XML namespaces for simpler parsing
        $xml = preg_replace('/xmlns[^=]*="[^"]*"/i', '', $xml);
        $xml = preg_replace('/<w:(\w+)/i', '<$1', $xml);
        $xml = preg_replace('/<\/w:(\w+)/i', '</$1', $xml);
        $xml = preg_replace('/<(\w+):(\w+)/i', '<$2', $xml);
        $xml = preg_replace('/<\/(\w+):(\w+)/i', '</$2', $xml);

        $dom = new DOMDocument();
        @$dom->loadXML($xml);

        $xpath = new DOMXPath($dom);
        $paragraphs = $xpath->query('//p');

        $pages = [];
        $pageNum = 1;
        $pageText = '';
        $parasInPage = 0;
        $parasPerPage = 30; // Approximate

        foreach ($paragraphs as $para) {
            // Collect all text nodes
            $texts = $xpath->query('.//t', $para);
            $line  = '';
            foreach ($texts as $t) {
                $line .= $t->textContent;
            }

            // Check for page break
            $breaks = $xpath->query('.//lastRenderedPageBreak|.//pageBreakBefore', $para);
            if ($breaks->length > 0 && $pageText) {
                $pages[$pageNum] = trim($pageText);
                $pageNum++;
                $pageText    = '';
                $parasInPage = 0;
            }

            if (trim($line)) {
                $pageText    .= $line . "\n";
                $parasInPage++;

                if ($parasInPage >= $parasPerPage) {
                    $pages[$pageNum] = trim($pageText);
                    $pageNum++;
                    $pageText    = '';
                    $parasInPage = 0;
                }
            }
        }

        if (trim($pageText)) {
            $pages[$pageNum] = trim($pageText);
        }

        return $pages ?: [1 => 'No text content extracted'];
    }

    /**
     * Split text into overlapping chunks of ~N words.
     * Callers must attach the same pageNumber to every returned chunk so
     * multi-chunk pages never lose their original PDF page.
     */
    public function chunkText(string $text, int $chunkSize = 500, int $overlap = 50): array {
        $words  = preg_split('/\s+/', trim($text), -1, PREG_SPLIT_NO_EMPTY);
        $total  = count($words);
        $chunks = [];
        $step   = max(1, $chunkSize - $overlap);

        for ($i = 0; $i < $total; $i += $step) {
            $slice   = array_slice($words, $i, $chunkSize);
            $chunks[] = implode(' ', $slice);
            if ($i + $chunkSize >= $total) break;
        }

        return $chunks ?: [trim($text)];
    }

    /**
     * Detect a full PDF page that is a table of contents / index.
     *
     * TOC pages are dominated by section titles with dotted leaders and trailing
     * page numbers (e.g. "Verification ........ 49"). They keyword-match queries
     * but do not contain the explanatory text used to compose answers, so they
     * are excluded from chunk indexing (see DocumentController::parseDocument).
     */
    public static function isTableOfContentsPage(string $text): bool {
        if (preg_match('/\btable\s+of\s+contents\b/ui', $text)) {
            return true;
        }

        // "Contents" heading plus dotted leaders is a strong TOC signal.
        if (preg_match('/\bcontents\b/ui', $text) && preg_match('/\.{4,}/', $text)) {
            return true;
        }

        $lines = array_values(array_filter(array_map('trim', explode("\n", $text))));
        if (count($lines) < 4) {
            return false;
        }

        $tocLines = 0;
        foreach ($lines as $line) {
            if (self::looksLikeTocEntryLine($line)) {
                $tocLines++;
            }
        }

        return ($tocLines / count($lines)) >= 0.35;
    }

    /**
     * Detect TOC-style content inside a single chunk (partial TOC page or
     * index fragment). Used at retrieval/reranking to deprioritise index hits.
     *
     * TOC chunks must never be used for source page attribution — they list
     * section names and target page numbers but contain no answer prose.
     */
    public static function isTableOfContentsChunk(string $content): bool {
        if (self::isTableOfContentsPage($content)) {
            return true;
        }

        $trimmed = trim($content);

        // Single-line TOC entry (very common in chunked index pages).
        if (self::looksLikeTocEntryLine($trimmed)) {
            return true;
        }

        // "Verification .......... 49" on its own — title + leader + page ref, no prose.
        if (preg_match('/^[\d.]?\s*[A-Z][^.!?]{2,70}[\s\.]{2,}\d{1,4}\s*$/um', $trimmed)) {
            return true;
        }

        $lines = array_values(array_filter(array_map('trim', explode("\n", $content))));
        if (count($lines) < 2) {
            return self::isIndexLikeShortText($trimmed);
        }

        $tocLines = 0;
        foreach ($lines as $line) {
            if (self::looksLikeTocEntryLine($line)) {
                $tocLines++;
            }
        }

        if (($tocLines / count($lines)) >= 0.4) {
            return true;
        }

        // Mostly short lines ending in page numbers → index page.
        return self::isIndexLikeShortText($trimmed);
    }

    /**
     * Heuristic for index fragments: short text, no sentence punctuation, ends with page number.
     */
    private static function isIndexLikeShortText(string $text): bool {
        if (mb_strlen($text) > 200) {
            return false;
        }
        if (preg_match('/[.!?]\s+[A-Z]/', $text)) {
            return false; // contains real sentences
        }
        // Ends with a page reference after leaders/whitespace
        if (preg_match('/[\s\.]{3,}\d{1,4}\s*$/', $text)) {
            return true;
        }
        // Few words, ends with isolated number (pdftotext -layout spacing)
        if (preg_match('/\s(\d{1,4})\s*$/', $text, $m)) {
            $words = preg_split('/\s+/u', trim($text));
            return count($words) <= 10 && (int) $m[1] <= 999;
        }
        return false;
    }

    /**
     * A single line that looks like "Section title .... 12".
     */
    private static function looksLikeTocEntryLine(string $line): bool {
        $len = mb_strlen($line);
        if ($len < 5 || $len > 120) {
            return false;
        }

        // "Verification ........ 49" — dots or spaces as leaders (pdftotext -layout)
        if (preg_match('/^[\d.]?\s*.+?[\s\.]{2,}\d{1,4}\s*$/u', $line)) {
            return true;
        }

        // Tab-aligned title + page number
        if (preg_match('/^.+\t+\d{1,4}\s*$/u', $line)) {
            return true;
        }

        // Dense dot leaders ending in a page number
        if (preg_match('/\.{4,}/', $line) && preg_match('/\d{1,4}\s*$/', $line)) {
            return true;
        }

        // Short title-case line ending in page number, no sentence punctuation
        if (!preg_match('/[.!?]/', $line) && preg_match('/\s(\d{1,4})\s*$/', $line, $m)) {
            $words = preg_split('/\s+/u', trim($line));
            if (count($words) <= 8 && (int) $m[1] <= 999 && (int) $m[1] !== (int) $m[0]) {
                return true;
            }
        }

        return false;
    }

    /**
     * Extract keywords from the last 10% of pages (annexure / index / glossary).
     */
    public function extractKeywords(array $pages): string {
        if (empty($pages)) return '';

        $total     = count($pages);
        $startPage = max(1, (int) ceil($total * 0.9));
        $tail      = '';

        foreach ($pages as $num => $text) {
            if ($num >= $startPage) $tail .= $text . ' ';
        }

        // Find bold/heading-like terms (lines that are short and capitalized)
        $lines    = explode("\n", $tail);
        $keywords = [];

        foreach ($lines as $line) {
            $line = trim($line);
            if (!$line || strlen($line) > 80) continue;
            // Heading-like: first letter uppercase, no sentence punctuation
            if (preg_match('/^[A-Z][^.?!]{2,60}$/', $line)) {
                $keywords[] = $line;
            }
        }

        return implode(', ', array_unique(array_slice($keywords, 0, 100)));
    }

    // ── Private methods ────────────────────────────────────────────

    private function parsePdfWithPoppler(string $path): array {
        $tmpBase = sys_get_temp_dir() . '/nautilus_pdf_' . uniqid();
        $envPath = $this->getShellPath();
        $cmd     = sprintf('PATH=%s pdftotext -layout %s %s.txt 2>/dev/null', escapeshellarg($envPath), escapeshellarg($path), escapeshellarg($tmpBase));

        require_once __DIR__ . '/../core/Logger.php';
        Logger::info('[PDF_CMD] ' . $cmd);

        exec($cmd, $out, $code);

        $txtFile = $tmpBase . '.txt';
        Logger::info('[PDF_CMD_EXIT] exit_code=' . (int) $code . ' txt_exists=' . (int) file_exists($txtFile));

        if (!file_exists($txtFile)) {
            // capture some debug info if available
            Logger::info('[PDF_EXTRACTION] pdftotext did not produce a .txt file for: ' . basename($path));
            // run debug info
            $this->debugPdfInfo($path);
            throw new RuntimeException("pdftotext failed for: $path");
        }

        $text = (string) file_get_contents($txtFile);

        // Log raw file metrics immediately
        Logger::info('TXT filesize=' . filesize($txtFile));
        Logger::info('TXT length=' . strlen($text));
        Logger::info('Form feeds=' . substr_count($text, "\f"));
        Logger::info('First500=' . substr($text, 0, 500));
        Logger::info('Last500=' . substr($text, -500));

        // Remove file after reading
        @unlink($txtFile);

        // pdftotext uses \f (form feed) as page separator — index matches real PDF pages.
  // Keep blank pages so later non-empty pages are not shifted (critical for #page=N).
$rawPages = explode("\f", $text);

Logger::info("Raw pages = " . count($rawPages));

foreach ($rawPages as $i => $page) {
    Logger::info(
        "PAGE " .
        ($i + 1) .
        " LENGTH=" .
        strlen($page)
    );
}

$pages = [];

foreach ($rawPages as $i => $page) {
    $pageNumber = $i + 1;
    $trimmed = trim($page);

    Logger::info(sprintf(
        'PAGE %d length=%d',
        $pageNumber,
        strlen($trimmed)
    ));

    $pages[$pageNumber] = $trimmed;
}

        // Drop trailing blank page that pdftotext often emits after the final \f
        while (!empty($pages) && end($pages) === '') {
            array_pop($pages);
        }

        // Log extraction details
        $nonEmptyCount = count(array_filter($pages));
        $totalPages = count($pages);
        Logger::info("[PDF_EXTRACTION] pdftotext output: total_pages=$totalPages, non_empty_pages=$nonEmptyCount, file=" . basename($path));

        // If extracted pages are suspiciously low, compare with pdfinfo and try fallback
        if ($totalPages < 10) {
            $pdfPages = $this->getPdfPageCount($path);
            Logger::info('[PDF_EXTRACTION] suspiciously low page count from pdftotext. pdfinfo_pages=' . var_export($pdfPages, true));
            if ($pdfPages !== null && $pdfPages >= 10 && $pdfPages > $totalPages) {
                Logger::info('[PDF_FALLBACK] Attempting fallback extraction with pdftotext -raw');
                $tmpBase2 = sys_get_temp_dir() . '/nautilus_pdf_' . uniqid();
                $cmd2 = sprintf('PATH=%s pdftotext -raw %s %s.txt 2>/dev/null', escapeshellarg($envPath), escapeshellarg($path), escapeshellarg($tmpBase2));
                Logger::info('[PDF_CMD] ' . $cmd2);
                exec($cmd2, $out2, $code2);
                $txtFile2 = $tmpBase2 . '.txt';
                Logger::info('[PDF_CMD_EXIT] fallback_exit=' . (int) $code2 . ' txt_exists=' . (int) file_exists($txtFile2));
                if (file_exists($txtFile2)) {
                    $text2 = (string) file_get_contents($txtFile2);
                    Logger::info('FALLBACK TXT filesize=' . filesize($txtFile2));
                    Logger::info('FALLBACK TXT length=' . strlen($text2));
                    Logger::info('FALLBACK Form feeds=' . substr_count($text2, "\f"));
                    Logger::info('FALLBACK First500=' . substr($text2, 0, 500));
                    Logger::info('FALLBACK Last500=' . substr($text2, -500));
                    @unlink($txtFile2);

                    $rawPages2 = explode("\f", $text2);
                    $pages2 = [];
                    foreach ($rawPages2 as $i => $page) {
                        $pageNumber = $i + 1;
                        $trimmed    = trim($page);
                        Logger::info(sprintf('FALLBACK PAGE %d length=%d', $pageNumber, strlen($trimmed)));
                        $pages2[$pageNumber] = $trimmed;
                    }
                    while (!empty($pages2) && end($pages2) === '') {
                        array_pop($pages2);
                    }

                    $nonEmpty2 = count(array_filter($pages2));
                    $total2 = count($pages2);
                    Logger::info("[PDF_EXTRACTION] fallback pdftotext output: total_pages=$total2, non_empty_pages=$nonEmpty2, file=" . basename($path));

                    if ($total2 > $totalPages) {
                        Logger::info('[PDF_FALLBACK] Fallback extraction produced more pages; using fallback result');
                        return $pages2 ?: [1 => 'No text extracted'];
                    }
                }
            }
        }

        return $pages ?: [1 => 'No text extracted'];
    }

    /**
     * Run pdfinfo and pdfinfo -meta for debugging and log key fields.
     */
    private function debugPdfInfo(string $path): void {
        require_once __DIR__ . '/../core/Logger.php';
        if (!$this->commandExists('pdfinfo')) {
            Logger::info('[PDFINFO] pdfinfo not available on PATH');
            return;
        }

        $envPath = $this->getShellPath();
        $output1 = [];
        $code1 = 0;
        exec(sprintf('PATH=%s pdfinfo %s 2>&1', escapeshellarg($envPath), escapeshellarg($path)), $output1, $code1);
        Logger::info('[PDFINFO] exit=' . (int) $code1);
        foreach ($output1 as $line) {
            Logger::info('[PDFINFO] ' . $line);
        }

        $output2 = [];
        $code2 = 0;
        exec(sprintf('PATH=%s pdfinfo -meta %s 2>&1', escapeshellarg($envPath), escapeshellarg($path)), $output2, $code2);
        Logger::info('[PDFINFO_META] exit=' . (int) $code2);
        foreach ($output2 as $line) {
            Logger::info('[PDFINFO_META] ' . $line);
        }

        // Try to surface key fields for easier scanning
        $combined = array_merge($output1, $output2);
        $fields = ['Pages', 'Encrypted', 'Page size', 'PDF version', 'Producer', 'Creator'];
        foreach ($combined as $line) {
            foreach ($fields as $f) {
                if (stripos($line, $f . ':') !== false) {
                    Logger::info('[PDFINFO_FIELD] ' . trim($line));
                }
            }
        }
    }

    private function parsePdfWithOcr(string $path): array {
        $pageCount = $this->getPdfPageCount($path);
        if ($pageCount === null || $pageCount < 1) {
            throw new RuntimeException("Unable to determine PDF page count for OCR fallback: $path");
        }

        $tmpBase = sys_get_temp_dir() . '/nautilus_pdf_ocr_' . uniqid();
        $env_path = $this->getShellPath();
        $cmd     = sprintf('PATH=%s pdftoppm -r 200 -png %s %s 2>/dev/null', escapeshellarg($env_path), escapeshellarg($path), escapeshellarg($tmpBase));
        exec($cmd, $out, $code);
        if ($code !== 0) {
            throw new RuntimeException("pdftoppm failed for OCR fallback: $path");
        }

        $pages = [];
        for ($page = 1; $page <= $pageCount; $page++) {
            $imageFile = sprintf('%s-%d.png', $tmpBase, $page);
            if (!file_exists($imageFile)) {
                continue;
            }
            $envPath = $this->getShellPath();
            $text = trim((string) shell_exec(sprintf('PATH=%s tesseract %s stdout 2>/dev/null', escapeshellarg($envPath), escapeshellarg($imageFile))));
            @unlink($imageFile);
            $pages[$page] = $text;
        }

        foreach (glob($tmpBase . '-*.png') as $remaining) {
            @unlink($remaining);
        }

        if (empty($pages)) {
            throw new RuntimeException("OCR produced no text for: $path");
        }

        return $pages;
    }

    private function getPdfPageCount(string $path): ?int {
        if ($this->commandExists('pdfinfo')) {
            $env_path = $this->getShellPath();
            $output = [];
            $code = 0;
            exec(sprintf('PATH=%s pdfinfo %s 2>/dev/null', escapeshellarg($env_path), escapeshellarg($path)), $output, $code);
            if ($code === 0) {
                foreach ($output as $line) {
                    if (preg_match('/^Pages:\s*(\d+)/i', $line, $matches)) {
                        return (int) $matches[1];
                    }
                }
            }
        }

        $content = file_get_contents($path);
        if ($content === false) {
            return null;
        }

        preg_match_all('/\/Type\s*\/Page[^s]/', $content, $matches);
        return count($matches) ?: null;
    }

    private function parsePdfPhp(string $path): array {
        // Minimal pure-PHP PDF text extraction
        // Works on standard text PDFs; scanned PDFs will return minimal text
        $content = file_get_contents($path);
        if (!$content) throw new RuntimeException("Cannot read PDF: $path");

        $pages    = [];
        $pageNum  = 1;

        // Extract stream contents
        preg_match_all('/stream(.*?)endstream/s', $content, $streams);
        $allText = '';

        foreach ($streams[1] as $stream) {
            $stream = trim($stream);

            // Try zlib decompress
            if (substr($stream, 0, 2) === "\x78\x9c" || substr($stream, 0, 2) === "\x78\x01" || substr($stream, 0, 2) === "\x78\xda") {
                $decoded = @gzuncompress($stream);
                if ($decoded !== false) {
                    $allText .= $this->extractPdfText($decoded) . "\n";
                }
            } else {
                $allText .= $this->extractPdfText($stream) . "\n";
            }
        }

        // Split into pseudo-pages (no page boundary info in this mode)
        $lines    = array_filter(explode("\n", $allText), 'trim');
        $perPage  = 40;
        $chunks   = array_chunk(array_values($lines), $perPage);

        foreach ($chunks as $i => $chunk) {
            $text = implode("\n", $chunk);
            if (trim($text)) $pages[$i + 1] = $text;
        }

        return $pages ?: [1 => 'No extractable text found (may be a scanned PDF)'];
    }

    private function extractPdfText(string $stream): string {
        preg_match_all('/BT(.*?)ET/s', $stream, $blocks);
        $lines = [];

        foreach ($blocks[1] as $block) {
            // (text) Tj
            if (preg_match_all('/\((?:[^\\\\\)]|\\\\.)*\)\s*Tj/s', $block, $tj)) {
                foreach ($tj[0] as $match) {
                    if (preg_match('/\((.*)\)\s*Tj/s', $match, $m)) {
                        $decoded = $this->decodePdfString($m[1]);
                        if (trim($decoded) !== '') {
                            $lines[] = $decoded;
                        }
                    }
                }
            }

            // [ (...) ... ] TJ
            if (preg_match_all('/\[([^\]]*)\]\s*TJ/s', $block, $tjArrays)) {
                foreach ($tjArrays[1] as $array) {
                    if (preg_match_all('/\((?:[^\\\\\)]|\\\\.)*\)/s', $array, $parts)) {
                        foreach ($parts[0] as $part) {
                            $decoded = $this->decodePdfString(trim($part, '()'));
                            if (trim($decoded) !== '') {
                                $lines[] = $decoded;
                            }
                        }
                    }
                }
            }

            // <48656c6c6f> Tj hex strings
            if (preg_match_all('/<([0-9A-Fa-f]+)>\s*Tj/', $block, $hex)) {
                foreach ($hex[1] as $h) {
                    $decoded = $this->decodePdfHexString($h);
                    if (trim($decoded) !== '') {
                        $lines[] = $decoded;
                    }
                }
            }
        }

        return implode(' ', $lines);
    }

    private function decodePdfHexString(string $hex): string {
        $hex = preg_replace('/\s+/', '', $hex);
        if ($hex === '' || strlen($hex) % 2 !== 0) {
            return '';
        }
        $out = '';
        for ($i = 0; $i < strlen($hex); $i += 2) {
            $out .= chr(hexdec(substr($hex, $i, 2)));
        }
        return $out;
    }

    private function decodePdfString(string $s): string {
        $s = preg_replace_callback('/\\\\([\\\\nrtbf()])/', function ($m) {
            return match ($m[1]) {
                'n' => "\n",
                'r' => "\r",
                't' => "\t",
                'b' => "\x08",
                'f' => "\x0C",
                default => $m[1],
            };
        }, $s);
        return $s;
    }

    private function getShellPath(): string {
        $env_path = getenv('PATH') ?: '';
        foreach (['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin'] as $binDir) {
            if (!str_contains($env_path, $binDir)) {
                $env_path = $binDir . ':' . $env_path;
            }
        }
        return $env_path;
    }

    private function commandExists(string $cmd): bool {
        $env_path = $this->getShellPath();
        $result = shell_exec(sprintf('PATH=%s command -v %s 2>/dev/null', escapeshellarg($env_path), escapeshellarg($cmd)));
        return !empty(trim($result ?? ''));
    }
}
