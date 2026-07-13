<?php
// backend/api/v1/chat/ChatController.php

require_once __DIR__ . '/../../../services/LLMService.php';
require_once __DIR__ . '/../../../services/ChunkReranker.php';
require_once __DIR__ . '/../../../services/DocumentParser.php';
require_once __DIR__ . '/../../../services/SourceAttributor.php';
require_once __DIR__ . '/../../../middleware/AuthMiddleware.php';
require_once __DIR__ . '/../../../middleware/RateLimiter.php';

class ChatController {

    private const STOPWORDS = [
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on',
        'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before',
        'after', 'above', 'below', 'between', 'under', 'again', 'then', 'once',
        'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
        'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
        'own', 'same', 'so', 'than', 'too', 'very', 'just', 'what', 'which',
        'who', 'whom', 'this', 'that', 'these', 'those', 'and', 'but', 'if',
        'or', 'because', 'until', 'while', 'about', 'any', 'our', 'your',
        'their', 'my', 'we', 'you', 'they', 'it', 'its', 'he', 'she', 'me',
        'him', 'her', 'us', 'them', 'also', 'please', 'tell', 'give', 'know',
        'explain', 'describe', 'say', 'find',
    ];

    public function ask(array $params = []): void {
        $user = AuthMiddleware::require();
        $cfg  = require __DIR__ . '/../../../config/config.php';

        // Rate limit: 10 questions per minute per user
        RateLimiter::check("chat:{$user['id']}", $cfg['rate_limit']['chat_per_minute'], 60);

        $errors = Request::validate(['question' => 'required|min:3|max:2000']);
        if ($errors) {
            Response::error('Validation failed', 422, $errors);
            return;
        }

        $question   = trim(strip_tags(Request::post('question')));
        $sessionId  = Request::post('session_id');
        $categoryId = Request::post('category_id') ? (int) Request::post('category_id') : null;

        // Create or validate session
        if ($sessionId) {
            $session = Database::queryOne(
                'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?',
                [$sessionId, $user['id']]
            );
            if (!$session) {
                Response::error('Session not found', 404);
                return;
            }
        } else {
            $title     = mb_substr($question, 0, 80);
            $sessionId = Database::insert(
                'INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)',
                [$user['id'], $title]
            );
        }

        // ── Step 1: FAQ cache check ──────────────────────────────
        $normalised = $this->normaliseQuestion($question);
        $hash       = hash('sha256', $normalised);
        $faq        = Database::queryOne(
            'SELECT * FROM faqs WHERE question_hash = ?',
            [$hash]
        );

        if ($faq && $faq['ask_count'] >= $cfg['faq']['cache_threshold'] && $faq['canonical_answer']) {
            // Cached answer — still attach PDF sources from retrieval so cards always render.
            $retrieval = $this->retrieveChunks($question, $categoryId, $cfg['llm']['context_chunks']);
            $cachedSources = SourceAttributor::ensureNonEmptySources(
                [],
                $retrieval['for_llm'] ?? [],
                $retrieval['for_fallback'] ?? []
            );
            $rawCached = $cachedSources;
            $cachedSources = $this->enrichSources($cachedSources);
            if (empty($cachedSources) && !empty($rawCached)) {
                $cachedSources = $rawCached;
            }

            $msgId = $this->persistMessage(
                $sessionId, $user['id'], $question,
                $faq['canonical_answer'], $categoryId, 1, 0.99
            );
            foreach ($cachedSources as $src) {
                $page = $src['page_number'] ?? $src['pageNumber'] ?? null;
                Database::insert(
                    'INSERT INTO message_sources (message_id, document_id, page_number, relevance_rank) VALUES (?,?,?,?)',
                    [
                        $msgId,
                        $src['fileId'] ?? $src['document_id'],
                        $page !== null ? (int) $page : 0,
                        $src['relevance_rank'] ?? 1,
                    ]
                );
            }
            $this->upsertFaq($hash, $question, $faq['canonical_answer'], $categoryId);

            Logger::info('[chat-response] FAQ cache sources.length=' . count($cachedSources));

            Response::success([
                'session_id'  => (int) $sessionId,
                'message_id'  => (int) $msgId,
                'answer'      => $faq['canonical_answer'],
                'sources'     => $cachedSources,
                'is_answered' => true,
                'from_cache'  => true,
            ]);
            return;
        }

        // ── Step 2: Auto-detect category from keywords ───────────
        if (!$categoryId) {
            $categoryId = $this->detectCategory($question);
        }

        // ── Step 3: Retrieve relevant document chunks ─────────────
        $retrieval = $this->retrieveChunks($question, $categoryId, $cfg['llm']['context_chunks']);
        $chunks    = $retrieval['for_llm'];
        $allChunks = $retrieval['for_fallback'];

        // TOC filter may empty for_llm while fallback still has chunks — do not treat as "no documents".
        if (empty($chunks) && !empty($allChunks)) {
            Logger::info('[retrieval] for_llm empty after TOC filter — promoting non-TOC chunks from fallback');
            $chunks = array_values(array_filter(
                $allChunks,
                fn($c) => !DocumentParser::isTableOfContentsChunk($c['content'] ?? '')
            ));
            if (empty($chunks)) {
                $chunks = $allChunks;
            }
        }

        if (empty($chunks)) {
            // No documents found at all
            $answer  = 'I could not find any relevant information in the knowledge base for your question.';
            $msgId   = $this->persistMessage($sessionId, $user['id'], $question, $answer, $categoryId, 0, 0.0);
            $queryId = Database::insert(
                'INSERT INTO unanswered_queries (message_id, user_id, question) VALUES (?, ?, ?)',
                [$msgId, $user['id'], $question]
            );
            Response::success([
                'session_id'   => (int) $sessionId,
                'message_id'   => (int) $msgId,
                'answer'       => $answer,
                'sources'      => [],
                'is_answered'  => false,
                'query_id'     => (int) $queryId,
            ]);
            return;
        }

        // ── Step 4: LLM call ──────────────────────────────────────
        try {
            $llm    = new LLMService();
            $result = $llm->answerWithFallback($question, $allChunks, $chunks);

            if (!$result['answered']) {
                $recovered = $this->recoverAnswerFromChunks($question, $chunks, $allChunks);
                if ($recovered !== null) {
                    $result = $recovered;
                    Logger::info('[chat-response] recovered answer from retrieved chunk after LLM not-found');
                }
            }
        } catch (Throwable $e) {
            Logger::error('LLM failed: ' . $e->getMessage());
            $cfg = require __DIR__ . '/../../../config/config.php';
            $msg = !empty($cfg['app']['debug'])
                ? $e->getMessage()
                : 'AI service temporarily unavailable. Please try again.';
            Response::error($msg, 503);
            return;
        }

        // ── Step 5: Persist ───────────────────────────────────────
        // Hard guarantee: every document-backed answer includes ≥1 source.
        if (!empty($result['answered'])) {
            $result['sources'] = SourceAttributor::ensureNonEmptySources(
                is_array($result['sources'] ?? null) ? $result['sources'] : [],
                $chunks,
                $allChunks
            );
        } else {
            $result['sources'] = [];
        }

        $msgId = $this->persistMessage(
            $sessionId, $user['id'], $question,
            $result['answer'], $categoryId,
            $result['answered'] ? 1 : 0,
            $result['confidence']
        );

        foreach ($result['sources'] as $src) {
            $page = $src['page_number'] ?? $src['pageNumber'] ?? null;
            $docId = (int) ($src['document_id'] ?? $src['fileId'] ?? 0);
            if ($docId <= 0) {
                continue;
            }
            Database::insert(
                'INSERT INTO message_sources (message_id, document_id, page_number, relevance_rank) VALUES (?,?,?,?)',
                [
                    $msgId,
                    $docId,
                    $page !== null ? (int) $page : 0,
                    $src['relevance_rank'] ?? 0,
                ]
            );
        }

        $queryId = null;
        if (!$result['answered']) {
            $queryId = Database::insert(
                'INSERT INTO unanswered_queries (message_id, user_id, question) VALUES (?, ?, ?)',
                [$msgId, $user['id'], $question]
            );
        }

        $this->upsertFaq($hash, $question, $result['answer'], $categoryId);

        $sources = $this->enrichSources($result['sources']);
        if ($result['answered'] && empty($sources) && !empty($result['sources'])) {
            Logger::warn('[chat-response] enrichSources emptied sources — restoring raw');
            $sources = $result['sources'];
        }

        // Absolute last resort: build one source from the top retrieved chunk
        if ($result['answered'] && empty($sources) && !empty($allChunks)) {
            $sources = $this->enrichSources([
                SourceAttributor::chunkToSource($allChunks[0]),
            ]);
            Logger::warn('[chat-response] last-resort source from allChunks[0]');
        }

        Logger::info('[chat-response] sources.length=' . count($sources)
            . ' pages=' . implode(',', array_map(
                fn($s) => (string) ($s['pageNumber'] ?? $s['page_number'] ?? 'none'),
                $sources
            )));

        Response::success([
            'session_id'  => (int) $sessionId,
            'message_id'  => (int) $msgId,
            'answer'      => $result['answer'],
            'sources'     => $sources,
            'is_answered' => (bool) $result['answered'],
            'query_id'    => $queryId ? (int) $queryId : null,
            'from_cache'  => false,
        ]);
    }

    /**
     * Locate the best source page(s) for a question using indexed document_chunks.
     * page_number values match the PDF viewer (#page=N) because ingestion uses pdftotext.
     */
    public function locateSource(array $params = []): void {
        $user = AuthMiddleware::require();
        unset($user);

        $question   = trim(strip_tags(Request::get('q') ?? Request::get('question') ?? ''));
        $answer     = trim(strip_tags(Request::get('answer') ?? ''));
        $documentId = Request::get('document_id') ? (int) Request::get('document_id') : null;

        if (mb_strlen($question) < 3) {
            Response::error('Question too short', 422);
            return;
        }

        $cfg       = require __DIR__ . '/../../../config/config.php';
        $retrieval = $this->retrieveChunks($question, null, 20);
        $chunks    = $retrieval['for_fallback'];

        $chunks = array_values(array_filter(
            $chunks,
            fn($c) => !DocumentParser::isTableOfContentsChunk($c['content'] ?? '')
        ));

        if ($documentId) {
            $chunks = array_values(array_filter(
                $chunks,
                fn($c) => (int) ($c['document_id'] ?? 0) === $documentId
            ));
        }

        if (empty($chunks)) {
            Response::success(['sources' => []]);
            return;
        }

        $headingQuery = mb_strlen($question) < 100 && !str_ends_with($question, '?');
        $attributeOn  = ($headingQuery || $answer === '') ? $question : $answer;

        $sources = SourceAttributor::attribute($attributeOn, $question, $chunks);

        if (empty($sources)) {
            $sources = [SourceAttributor::chunkToSource($chunks[0], 1)];
        }

        foreach ($sources as &$src) {
            $page = (int) ($src['page_number'] ?? $src['pageNumber'] ?? 0);
            if ($page > 0) {
                $src['page_label'] = 'Page ' . $page;
                $src['pageLabel']  = 'Page ' . $page;
            }
        }
        unset($src);

        Response::success(['sources' => $this->enrichSources($sources)]);
    }

    private static function extractPrintedPageFromText(string $text): ?int {
        if (preg_match('/Page\s+Number\s*:\s*Page\s*(\d+)\s+of\s+\d+/i', $text, $m)) {
            return (int) $m[1];
        }
        if (preg_match('/Page\s+Number\s*:\s*(\d+)/i', $text, $m)) {
            return (int) $m[1];
        }
        if (preg_match('/Page\s+(\d+)\s+of\s+\d+/i', $text, $m)) {
            return (int) $m[1];
        }
        return null;
    }

    public function sessions(array $params = []): void {
        $user = AuthMiddleware::require();
        ['page' => $page, 'perPage' => $perPage, 'offset' => $offset] = Request::paginate();

        $total = Database::queryOne(
            'SELECT COUNT(*) AS c FROM chat_sessions WHERE user_id = ?',
            [$user['id']]
        )['c'];

        $rows = Database::query(
            'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
            [$user['id'], $perPage, $offset]
        );

        Response::paginated($rows, (int) $total, $page, $perPage);
    }

    public function session(array $params): void {
        $user = AuthMiddleware::require();
        $id   = (int) ($params['id'] ?? 0);

        $session = Database::queryOne(
            'SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?',
            [$id, $user['id']]
        );

        if (!$session) {
            Response::error('Session not found', 404);
            return;
        }

        $messages = Database::query(
            'SELECT m.*,
             (SELECT JSON_ARRAYAGG(
                 JSON_OBJECT(
                     "document_id", s.document_id,
                     "document_title", d.title,
                     "page_number", NULLIF(s.page_number, 0),
                     "relevance_rank", s.relevance_rank,
                     "mime_type", d.mime_type,
                     "fileId", s.document_id,
                     "fileName", d.title,
                     "pageNumber", NULLIF(s.page_number, 0)
                 )
             ) FROM message_sources s JOIN documents d ON d.id = s.document_id WHERE s.message_id = m.id) AS sources
             FROM chat_messages m
             WHERE m.session_id = ?
             ORDER BY m.created_at ASC',
            [$id]
        );

        foreach ($messages as &$msg) {
            $decoded = json_decode($msg['sources'] ?? '[]', true) ?: [];
            $msg['sources'] = $this->enrichSources($decoded);
        }

        Response::success(['session' => $session, 'messages' => $messages]);
    }

    public function deleteSession(array $params): void {
        $user = AuthMiddleware::require();
        $id   = (int) ($params['id'] ?? 0);

        $affected = Database::execute(
            'DELETE FROM chat_sessions WHERE id = ? AND user_id = ?',
            [$id, $user['id']]
        );

        if (!$affected) {
            Response::error('Session not found', 404);
            return;
        }

        Response::success(null, 'Session deleted');
    }

    public function faqs(array $params = []): void {
        AuthMiddleware::require();

        $categoryId = Request::get('category_id');
        $limit      = min(50, (int) (Request::get('limit') ?? 20));

        $sql    = 'SELECT f.*, c.name AS category_name FROM faqs f LEFT JOIN categories c ON c.id = f.category_id';
        $binds  = [];

        if ($categoryId) {
            $sql   .= ' WHERE f.category_id = ?';
            $binds[] = (int) $categoryId;
        }

        $sql .= ' ORDER BY f.ask_count DESC LIMIT ?';
        $binds[] = $limit;

        Response::success(Database::query($sql, $binds));
    }

    public function categories(array $params = []): void {
        AuthMiddleware::require();
        $rows = Database::query(
            'SELECT id, name, slug, description, parent_id, sort_order
             FROM categories
             ORDER BY sort_order ASC, name ASC'
        );
        Response::success($rows);
    }

    public function submitQuery(array $params = []): void {
        $user = AuthMiddleware::require();

        $errors = Request::validate(['question' => 'required|min:5|max:2000']);
        if ($errors) {
            Response::error('Validation failed', 422, $errors);
            return;
        }

        $question = trim(strip_tags(Request::post('question')));
        $msgId    = Request::post('message_id');

        $id = Database::insert(
            'INSERT INTO unanswered_queries (message_id, user_id, question) VALUES (?, ?, ?)',
            [$msgId ?: null, $user['id'], $question]
        );

        Response::success(['query_id' => (int) $id], 'Query submitted. Admin will respond shortly.', 201);
    }

    // ── Private helpers ───────────────────────────────────────────

    /**
     * Add pdfUrl / pdf_url for each source so the UI can open
     * /chat/documents/{id}/file?token=...#page={pageNumber}.
     * pageNumber stays null-safe for legacy rows without page metadata.
     *
     * @param  array<int, array<string, mixed>> $sources
     * @return array<int, array<string, mixed>>
     */

    
    private function enrichSources(array $sources): array {
        $token = Request::bearerToken() ?? Request::get('token');
        $token = is_string($token) ? $token : '';

        $enriched = [];
        foreach ($sources as $src) {
            if (!is_array($src)) {
                continue;
            }

            $fileId = (int) ($src['fileId'] ?? $src['document_id'] ?? 0);
            if ($fileId <= 0) {
                Logger::warn('[chat-response] enrichSources skipped entry with invalid fileId: ' . json_encode($src));
                continue;
            }

            $pageRaw = $src['pageNumber'] ?? $src['page_number'] ?? null;
            $pageNumber = ($pageRaw !== null && (int) $pageRaw > 0) ? (int) $pageRaw : null;

            $pdfUrl = $token !== ''
                ? '/api/v1/chat/documents/' . $fileId . '/file?token=' . rawurlencode($token)
                : '/api/v1/chat/documents/' . $fileId . '/file';

            $fileName = $src['fileName'] ?? $src['document_title'] ?? '';
            $score    = isset($src['score']) ? (float) $src['score'] : null;
            $pageEnd  = $src['pageEnd'] ?? $src['page_end'] ?? null;
            $pageEnd  = ($pageEnd !== null && (int) $pageEnd > 0) ? (int) $pageEnd : null;
            $pageLabel = $src['pageLabel'] ?? $src['page_label'] ?? null;

            $enriched[] = [
                'document_id'    => $fileId,
                'document_title' => $fileName,
                'page_number'    => $pageNumber,
                'page_end'       => $pageEnd,
                'page_label'     => $pageLabel,
                'relevance_rank' => $src['relevance_rank'] ?? null,
                'mime_type'      => $src['mime_type'] ?? 'application/pdf',
                'fileId'         => $fileId,
                'fileName'       => $fileName,
                'pageNumber'     => $pageNumber,
                'pageEnd'        => $pageEnd,
                'pageLabel'      => $pageLabel,
                'score'          => $score,
                'pdfUrl'         => $pdfUrl,
                'pdf_url'        => $pdfUrl,
            ];
        }

        return $enriched;
    }

    private function normaliseQuestion(string $q): string {
        $q = mb_strtolower($q);
        $q = preg_replace('/[^\w\s]/u', ' ', $q);
        $q = preg_replace('/\s+/', ' ', $q);
        return trim($q);
    }

    private function detectCategory(string $question): ?int {
        $categories = Database::query('SELECT id, name FROM categories');
        $q = mb_strtolower($question);

        foreach ($categories as $cat) {
            if (str_contains($q, mb_strtolower($cat['name']))) {
                return (int) $cat['id'];
            }
        }
        return null;
    }

    /**
     * @return array{for_llm: array<int, array<string, mixed>>, for_fallback: array<int, array<string, mixed>>}
     */
    private function retrieveChunks(string $question, ?int $categoryId, int $limit): array {
        $limit      = max(1, $limit);
        // Fetch extra candidates so reranking can promote substantive pages over TOC hits.
        $fetchLimit = min($limit * 3, 24);
        $terms      = $this->extractSearchTerms($question);

        $chunks = $this->searchChunks($terms['natural'], $categoryId, $fetchLimit, 'natural');

        if (empty($chunks) && $terms['boolean'] !== '') {
            $chunks = $this->searchChunks($terms['boolean'], $categoryId, $fetchLimit, 'boolean');
        }

        if (empty($chunks) && !empty($terms['keywords'])) {
            $chunks = $this->likeSearchChunks($terms['keywords'], $categoryId, $fetchLimit);
        }

        // Widen to all categories if a filtered search returned too little
        if (count($chunks) < min(3, $fetchLimit) && $categoryId) {
            $more = $this->searchChunks($terms['natural'], null, $fetchLimit, 'natural');
            if (empty($more) && $terms['boolean'] !== '') {
                $more = $this->searchChunks($terms['boolean'], null, $fetchLimit, 'boolean');
            }
            if (empty($more) && !empty($terms['keywords'])) {
                $more = $this->likeSearchChunks($terms['keywords'], null, $fetchLimit);
            }
            $chunks = $this->mergeChunks($chunks, $more, $fetchLimit);
        }

        $chunks = $this->filterUsefulChunks($chunks);

        // Keep pre-TOC list for source fallback (reranked, TOC not yet removed).
        $forFallback = $chunks;

        // Drop TOC/index chunks — they keyword-match but lack answer prose.
        $chunks = array_values(array_filter(
            $chunks,
            fn($c) => !DocumentParser::isTableOfContentsChunk($c['content'] ?? '')
        ));

        // Re-rank: boost explanatory paragraphs, penalise any remaining index-like text.
        $reranker = new ChunkReranker();
        $forFallback = $reranker->rerank($forFallback, $question);
        $chunks      = $reranker->rerank($chunks, $question);

        $forLlm = array_slice($chunks, 0, $limit);
        $forFallback = array_slice($forFallback, 0, $limit);

        $forLlm = array_values(array_map(fn($chunk, $index) => $this->normalizeChunk($chunk, $index), $forLlm, array_keys($forLlm)));
        $forFallback = array_values(array_map(fn($chunk, $index) => $this->normalizeChunk($chunk, $index), $forFallback, array_keys($forFallback)));

        Logger::info("[retrieval]\n"
            . 'question=' . mb_substr($question, 0, 80) . "\n"
            . 'retrieved_chunk_count=' . count($forFallback) . "\n"
            . 'after_toc_filter_count=' . count($forLlm) . "\n"
            . "Retrieved chunks:\n"
            . $this->formatChunkLog($forFallback));

        return [
            'for_llm'       => $forLlm,
            'for_fallback'  => $forFallback,
        ];
    }

    private function normalizeChunk(array $chunk, int $index): array {
        $documentId = (int) ($chunk['document_id'] ?? 0);
        $title = (string) ($chunk['title'] ?? $chunk['fileName'] ?? $chunk['document_title'] ?? 'Document');
        $pageNumber = isset($chunk['page_number']) && (int) $chunk['page_number'] > 0
            ? (int) $chunk['page_number']
            : ((isset($chunk['pageNumber']) && (int) $chunk['pageNumber'] > 0) ? (int) $chunk['pageNumber'] : null);

        $normalized = $chunk;
        $normalized['fileId'] = $documentId;
        $normalized['fileName'] = $title;
        $normalized['pageNumber'] = $pageNumber;
        $normalized['page_number'] = $pageNumber;
        $normalized['text'] = (string) ($chunk['content'] ?? $chunk['text'] ?? '');
        $normalized['content'] = $normalized['text'];
        $normalized['sourceId'] = $index;
        $normalized['source_id'] = $index;
        return $normalized;
    }

    /** @param array<int, array<string, mixed>> $chunks */
    private function formatChunkLog(array $chunks): string {
        if (empty($chunks)) {
            return "  (none)\n";
        }
        $lines = [];
        foreach ($chunks as $i => $c) {
            $page = $c['pageNumber'] ?? $c['page_number'] ?? '?';
            $score = isset($c['rerank_score']) ? round((float) $c['rerank_score'], 3) : (isset($c['score']) ? round((float) $c['score'], 3) : 'n/a');
            $preview = mb_substr(preg_replace('/\s+/', ' ', (string) ($c['text'] ?? $c['content'] ?? '')), 0, 120);
            $lines[] = sprintf(
                '  sourceId=%s page=%s doc=%s score=%s is_toc=%s text=%s',
                $c['sourceId'] ?? $c['source_id'] ?? '?',
                $page,
                $c['document_id'] ?? $c['fileId'] ?? '?',
                $score,
                DocumentParser::isTableOfContentsChunk($c['content'] ?? '') ? 'YES' : 'no',
                $preview
            );
        }
        return implode("\n", $lines) . "\n";
    }

    private function filterUsefulChunks(array $chunks): array {
        return array_values(array_filter($chunks, fn($c) => $this->isUsefulChunk($c['content'] ?? '')));
    }

    private function isUsefulChunk(string $content): bool {
        $trimmed = trim($content);
        if (strlen($trimmed) < 20) {
            return false;
        }
        $bad = [
            'No extractable text found',
            'No text content extracted',
            'No text extracted',
        ];
        foreach ($bad as $phrase) {
            if (str_contains($trimmed, $phrase)) {
                return false;
            }
        }
        return true;
    }

    private function extractSearchTerms(string $question): array {
        $words = preg_split(
            '/\s+/',
            mb_strtolower(preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $question)),
            -1,
            PREG_SPLIT_NO_EMPTY
        );

        $significant = [];
        foreach ($words as $word) {
            if (strlen($word) >= 2 && !in_array($word, self::STOPWORDS, true)) {
                $significant[] = $word;
            }
        }

        $significant = array_values(array_unique($significant));
        $top         = array_slice($significant, 0, 12);

        return [
            'natural'  => implode(' ', $top),
            'boolean'  => implode(' ', array_map(
                fn($w) => strlen($w) >= 3 ? $w . '*' : $w,
                $top
            )),
            'keywords' => array_slice($top, 0, 5),
        ];
    }

    private function searchChunks(string $expr, ?int $categoryId, int $limit, string $mode): array {
        if ($expr === '') {
            return [];
        }

        $modeSql     = $mode === 'boolean' ? 'BOOLEAN MODE' : 'NATURAL LANGUAGE MODE';
        $categorySql = $categoryId ? 'AND d.category_id = ?' : '';
        $binds       = [$expr, $expr];
        if ($categoryId) {
            $binds[] = $categoryId;
        }
        $binds[] = $limit;

        try {
            return Database::query(
                "SELECT dc.document_id, dc.page_number, dc.content,
                        d.title, d.mime_type,
                        MATCH(dc.content) AGAINST (? IN $modeSql) AS score
                 FROM document_chunks dc
                 JOIN documents d ON d.id = dc.document_id AND d.status = 'ready'
                 WHERE MATCH(dc.content) AGAINST (? IN $modeSql)
                 $categorySql
                 ORDER BY score DESC
                 LIMIT ?",
                $binds
            );
        } catch (PDOException $e) {
            Logger::warn('FULLTEXT search failed: ' . $e->getMessage());
            return [];
        }
    }

    private function likeSearchChunks(array $keywords, ?int $categoryId, int $limit): array {
        $likes = [];
        $binds = [];

        foreach ($keywords as $keyword) {
            if (strlen($keyword) < 2) {
                continue;
            }
            $likes[] = 'dc.content LIKE ?';
            $binds[] = '%' . $keyword . '%';
        }

        if (empty($likes)) {
            return [];
        }

        $categorySql = $categoryId ? 'AND d.category_id = ?' : '';
        if ($categoryId) {
            $binds[] = $categoryId;
        }
        $binds[] = $limit;

        return Database::query(
            'SELECT dc.document_id, dc.page_number, dc.content,
                    d.title, d.mime_type, 1.0 AS score
             FROM document_chunks dc
             JOIN documents d ON d.id = dc.document_id AND d.status = \'ready\'
             WHERE (' . implode(' OR ', $likes) . ")
             $categorySql
             ORDER BY dc.document_id, dc.page_number
             LIMIT ?",
            $binds
        );
    }

    /** @param array<int, array<string, mixed>> $primary */
    /** @param array<int, array<string, mixed>> $secondary */
    private function mergeChunks(array $primary, array $secondary, int $limit): array {
        $seen   = [];
        $merged = [];

        foreach (array_merge($primary, $secondary) as $chunk) {
            $key = $chunk['document_id'] . ':' . $chunk['page_number'] . ':' . substr($chunk['content'], 0, 80);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $merged[]   = $chunk;
            if (count($merged) >= $limit) {
                break;
            }
        }

        return $merged;
    }

    /**
     * When the LLM returns "not found" but retrieval surfaced a substantive chunk,
     * quote the best matching passage so users still get document-backed answers.
     *
     * @param array<int, array<string, mixed>> $chunks
     * @param array<int, array<string, mixed>> $allChunks
     */
    private function recoverAnswerFromChunks(string $question, array $chunks, array $allChunks): ?array {
        if (empty($chunks)) {
            return null;
        }

        $reranker = new ChunkReranker();
        $ranked   = $reranker->rerank($chunks, $question);

        foreach ($ranked as $chunk) {
            $content = trim((string) ($chunk['content'] ?? ''));
            if (mb_strlen($content) < 80) {
                continue;
            }
            if (DocumentParser::isTableOfContentsChunk($content)) {
                continue;
            }

            $score = (float) ($chunk['rerank_score'] ?? 0);
            if ($score < 0.15) {
                continue;
            }

            $sentences = preg_split('/[.!?]+/u', $content, -1, PREG_SPLIT_NO_EMPTY) ?: [];
            $parts     = [];
            foreach ($sentences as $sentence) {
                $sentence = trim($sentence);
                if (mb_strlen($sentence) < 20) {
                    continue;
                }
                $parts[] = $sentence;
                if (mb_strlen(implode('. ', $parts)) >= 420) {
                    break;
                }
            }

            $answer = trim(implode('. ', $parts));
            if ($answer !== '' && !str_ends_with($answer, '.')) {
                $answer .= '.';
            }
            if (mb_strlen($answer) < 40) {
                continue;
            }

            $sources = SourceAttributor::ensureNonEmptySources(
                [SourceAttributor::chunkToSource($chunk, 1)],
                $chunks,
                $allChunks
            );

            return [
                'answer'     => $answer,
                'sources'    => $sources,
                'confidence' => 0.65,
                'answered'   => true,
            ];
        }

        return null;
    }

    private function persistMessage(
        int|string $sessionId, int $userId, string $question,
        string $answer, ?int $categoryId, int $isAnswered, float $confidence
    ): string {
        // Save user message
        Database::insert(
            'INSERT INTO chat_messages (session_id, user_id, role, question, category_id, created_at) VALUES (?,?,?,?,?,NOW())',
            [$sessionId, $userId, 'user', $question, $categoryId]
        );

        // Save assistant message
        $id = Database::insert(
            'INSERT INTO chat_messages (session_id, user_id, role, answer, category_id, is_answered, confidence_score, created_at) VALUES (?,?,?,?,?,?,?,NOW())',
            [$sessionId, $userId, 'assistant', $answer, $categoryId, $isAnswered, $confidence]
        );

        // Touch session updated_at
        Database::execute('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [$sessionId]);

        return $id;
    }

    private function upsertFaq(string $hash, string $question, string $answer, ?int $categoryId): void {
        $existing = Database::queryOne('SELECT id, ask_count FROM faqs WHERE question_hash = ?', [$hash]);

        if ($existing) {
            Database::execute(
                'UPDATE faqs SET ask_count = ask_count + 1, last_asked_at = NOW(), canonical_answer = ? WHERE question_hash = ?',
                [$answer, $hash]
            );
        } else {
            Database::insert(
                'INSERT INTO faqs (question_hash, canonical_question, canonical_answer, ask_count, category_id) VALUES (?,?,?,1,?)',
                [$hash, $question, $answer, $categoryId]
            );
        }
    }
}
