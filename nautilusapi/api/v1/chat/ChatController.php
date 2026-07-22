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

        $question     = trim(strip_tags(Request::post('question')));
        $sessionId    = Request::post('session_id');
        $categoryIds  = $this->parseCategoryIdsFromRequest(true);
        $userScoped   = $categoryIds !== null && count($categoryIds) > 0;
        // Single id kept for FAQ / message persistence columns.
        $categoryId   = $categoryIds && count($categoryIds) === 1 ? $categoryIds[0] : null;

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
        // When category filters are active, only reuse FAQs from those categories.
        if ($categoryIds && count($categoryIds) > 0) {
            $placeholders = implode(',', array_fill(0, count($categoryIds), '?'));
            $faq = Database::queryOne(
                "SELECT * FROM faqs WHERE question_hash = ? AND category_id IN ($placeholders)",
                [$hash, ...$categoryIds]
            );
        } else {
            $faq = Database::queryOne(
                'SELECT * FROM faqs WHERE question_hash = ?',
                [$hash]
            );
        }

        if ($faq && $faq['ask_count'] >= $cfg['faq']['cache_threshold'] && $faq['canonical_answer']) {
            // Cached answer — still attach PDF sources from retrieval so cards always render.
            $retrieval = $this->retrieveChunks($question, $categoryIds, $cfg['llm']['context_chunks']);
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
        // Only when the user did not pick manuals; keep multi-select as-is.
        if (!$categoryIds) {
            $detected = $this->detectCategory($question);
            if ($detected) {
                $categoryIds = [$detected];
                $categoryId  = $detected;
            }
        }

        // ── Step 3: Retrieve relevant document chunks ─────────────
        $retrieval = $this->retrieveChunks($question, $categoryIds, $cfg['llm']['context_chunks']);
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
                // Keep answering when only TOC-tagged chunks remain — frontend still grounds pages.
                $chunks = $allChunks;
            }
        }

        if (empty($chunks)) {
            // No documents found at all (or none in the user-selected manuals).
            $answer = $userScoped
                ? (count($categoryIds) > 1
                    ? 'The given question was not found in the selected categories.'
                    : 'The given question was not found in the selected category.')
                : 'I could not find any relevant information in the knowledge base for your question.';
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

        // Absolute last resort: first non-TOC retrieved chunk (never an index page)
        if ($result['answered'] && empty($sources) && !empty($allChunks)) {
            $nonToc = SourceAttributor::firstNonTocChunk($allChunks)
                ?? SourceAttributor::firstNonTocChunk($chunks);
            if ($nonToc !== null) {
                $sources = $this->enrichSources([
                    SourceAttributor::chunkToSource($nonToc),
                ]);
                Logger::warn('[chat-response] last-resort source from non-TOC chunk page='
                    . ($nonToc['page_number'] ?? '?'));
            }
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

        $question    = trim(strip_tags(Request::get('q') ?? Request::get('question') ?? ''));
        $answer      = trim(strip_tags(Request::get('answer') ?? ''));
        $documentId  = Request::get('document_id') ? (int) Request::get('document_id') : null;
        $categoryIds = $this->parseCategoryIdsFromRequest(false);

        if (mb_strlen($question) < 3) {
            Response::error('Question too short', 422);
            return;
        }

        $cfg       = require __DIR__ . '/../../../config/config.php';
        $retrieval = $this->retrieveChunks($question, $categoryIds, 20);
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
                     "category_id", d.category_id,
                     "category_name", c.name,
                     "fileId", s.document_id,
                     "fileName", d.title,
                     "pageNumber", NULLIF(s.page_number, 0)
                 )
             ) FROM message_sources s
                JOIN documents d ON d.id = s.document_id
                JOIN categories c ON c.id = d.category_id
                WHERE s.message_id = m.id) AS sources
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
        // Only categories that currently have at least one ready PDF.
        // Mime check matches the Next BFF: pdf mime, .pdf filename, or generic binary.
        $rows = Database::query(
            "SELECT c.id, c.name, c.slug, c.description, c.parent_id, c.sort_order,
                    (
                      SELECT COUNT(*)
                      FROM documents d
                      WHERE d.category_id = c.id
                        AND d.status = 'ready'
                        AND (
                          d.mime_type LIKE '%pdf%'
                          OR LOWER(IFNULL(d.original_filename, '')) LIKE '%.pdf'
                          OR IFNULL(d.mime_type, '') IN ('', 'application/octet-stream', 'binary/octet-stream')
                        )
                    ) AS doc_count
             FROM categories c
             WHERE EXISTS (
               SELECT 1
               FROM documents d
               WHERE d.category_id = c.id
                 AND d.status = 'ready'
                 AND (
                   d.mime_type LIKE '%pdf%'
                   OR LOWER(IFNULL(d.original_filename, '')) LIKE '%.pdf'
                   OR IFNULL(d.mime_type, '') IN ('', 'application/octet-stream', 'binary/octet-stream')
                 )
             )
             ORDER BY c.sort_order ASC, c.name ASC"
        );
        Response::success($rows);
    }

    /**
     * List indexed documents available for chat retrieval (scoped to categories).
     */
    public function documents(array $params = []): void {
        AuthMiddleware::require();

        $categoryIds = $this->parseCategoryIdsFromRequest(false);
        $status      = Request::get('status') ?: 'ready';

        $where = ['d.category_id IS NOT NULL'];
        $binds = [];

        if ($categoryIds && count($categoryIds) > 0) {
            $placeholders = implode(',', array_fill(0, count($categoryIds), '?'));
            $where[] = "d.category_id IN ($placeholders)";
            foreach ($categoryIds as $id) {
                $binds[] = $id;
            }
        }
        if ($status !== '') {
            $where[] = 'd.status = ?';
            $binds[] = $status;
        }

        $whereStr = implode(' AND ', $where);
        $rows = Database::query(
            "SELECT d.id, d.title, d.original_filename, d.mime_type, d.category_id, c.name AS category_name
             FROM documents d
             JOIN categories c ON c.id = d.category_id
             WHERE $whereStr
             ORDER BY c.sort_order ASC, c.name ASC, d.title ASC",
            $binds
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
                'category_id'    => isset($src['category_id']) ? (int) $src['category_id'] : null,
                'category_name'  => $src['category_name'] ?? null,
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
        $categories = Database::query('SELECT id, name FROM categories ORDER BY CHAR_LENGTH(name) DESC');
        $q = mb_strtolower($question);

        foreach ($categories as $cat) {
            $name = mb_strtolower(trim($cat['name']));
            if ($name !== '' && str_contains($q, $name)) {
                return (int) $cat['id'];
            }

            // Multi-word categories (e.g. "Ship Operating") — require two significant word hits.
            $words = array_values(array_filter(
                preg_split('/\s+/u', $name) ?: [],
                fn($w) => mb_strlen($w) >= 4
            ));
            if (count($words) >= 2) {
                $hits = 0;
                foreach ($words as $word) {
                    if (str_contains($q, $word)) {
                        $hits++;
                    }
                }
                if ($hits >= 2) {
                    return (int) $cat['id'];
                }
            }
        }
        return null;
    }


    /**
     * Parse selected category filter from request (multi-select).
     * Accepts category_ids (array) and/or category_id (single, legacy).
     * @return array<int>|null  null = no filter (all categories)
     */
    private function parseCategoryIdsFromRequest(bool $fromPost = true): ?array {
        $raw = $fromPost ? Request::post('category_ids') : Request::get('category_ids');
        $ids = [];
        if (is_array($raw)) {
            foreach ($raw as $v) {
                $id = (int) $v;
                if ($id > 0) $ids[] = $id;
            }
        } elseif (is_string($raw) && $raw !== '') {
            foreach (explode(',', $raw) as $v) {
                $id = (int) trim($v);
                if ($id > 0) $ids[] = $id;
            }
        }

        $single = $fromPost ? Request::post('category_id') : Request::get('category_id');
        if ($single) {
            $id = (int) $single;
            if ($id > 0) $ids[] = $id;
        }

        $ids = array_values(array_unique($ids));
        return $ids ?: null;
    }

    /**
     * @param array<int>|null $categoryIds
     * @return array{0: string, 1: array<int>}
     */
    private function categoryFilterSql(?array $categoryIds): array {
        if (!$categoryIds || count($categoryIds) === 0) {
            return ['', []];
        }
        $placeholders = implode(',', array_fill(0, count($categoryIds), '?'));
        return ["AND d.category_id IN ($placeholders)", $categoryIds];
    }

    /**
     * @return array{for_llm: array<int, array<string, mixed>>, for_fallback: array<int, array<string, mixed>>}
     */
    private function retrieveChunks(string $question, ?array $categoryIds, int $limit): array {
        $limit      = max(1, $limit);
        // Fetch extra candidates so reranking can promote substantive pages over TOC hits.
        $fetchLimit = min($limit * 3, 24);
        $terms      = $this->extractSearchTerms($question);

        $chunks = $this->searchChunks($terms['natural'], $categoryIds, $fetchLimit, 'natural');

        // Prefer required-term boolean (+word) so one common word cannot dominate.
        if (empty($chunks) && ($terms['required'] ?? '') !== '') {
            $chunks = $this->searchChunks($terms['required'], $categoryIds, $fetchLimit, 'boolean');
        }

        if (empty($chunks) && $terms['boolean'] !== '') {
            $chunks = $this->searchChunks($terms['boolean'], $categoryIds, $fetchLimit, 'boolean');
        }

        // Typo-tolerant pass: prefix wildcards recover misspelled words.
        if (empty($chunks) && ($terms['fuzzy'] ?? '') !== '' && $terms['fuzzy'] !== $terms['boolean']) {
            $chunks = $this->searchChunks($terms['fuzzy'], $categoryIds, $fetchLimit, 'boolean');
            if (!empty($chunks)) {
                Logger::info('[retrieval] fuzzy prefix search matched after exact search failed');
            }
        }

        // LIKE: AND first (precise), then OR only as last resort.
        if (empty($chunks) && !empty($terms['keywords'])) {
            $chunks = $this->likeSearchChunks($terms['keywords'], $categoryIds, $fetchLimit, 'and');
        }

        if (empty($chunks) && !empty($terms['keywords'])) {
            $chunks = $this->likeSearchChunks($terms['keywords'], $categoryIds, $fetchLimit, 'or');
        }

        // LIKE with typo-tolerant prefixes as the final lexical fallback.
        if (empty($chunks) && !empty($terms['keywords'])) {
            $prefixes = array_map(
                fn($w) => strlen($w) >= 6 ? substr($w, 0, max(4, strlen($w) - 3)) : $w,
                $terms['keywords']
            );
            $chunks = $this->likeSearchChunks($prefixes, $categoryIds, $fetchLimit, 'and');
            if (empty($chunks)) {
                $chunks = $this->likeSearchChunks($prefixes, $categoryIds, $fetchLimit, 'or');
            }
        }

        $chunks = $this->filterUsefulChunks($chunks);

        // Keep pre-TOC list for source fallback (reranked, TOC not yet removed).
        $forFallback = $chunks;

        // Drop TOC/index chunks — they keyword-match but lack answer prose.
        $chunks = array_values(array_filter(
            $chunks,
            fn($c) => !DocumentParser::isTableOfContentsChunk($c['content'] ?? '')
        ));

        // Re-rank: boost on-topic explanatory paragraphs, penalise keyword-only pages.
        $reranker = new ChunkReranker();
        $forFallback = $reranker->rerank($forFallback, $question);
        $chunks      = $reranker->rerank($chunks, $question);

        // Drop weak topic overlap before the LLM sees the context.
        $forFallback = $reranker->filterWeakTopicChunks($forFallback, $question);
        $chunks      = $reranker->filterWeakTopicChunks($chunks, $question);

        $forLlm = array_slice($chunks, 0, $limit);
        $forFallback = array_slice($forFallback, 0, $limit);

        $forLlm = array_values(array_map(fn($chunk, $index) => $this->normalizeChunk($chunk, $index), $forLlm, array_keys($forLlm)));
        $forFallback = array_values(array_map(fn($chunk, $index) => $this->normalizeChunk($chunk, $index), $forFallback, array_keys($forFallback)));

        Logger::info("[retrieval]\n"
            . 'question=' . mb_substr($question, 0, 80) . "\n"
            . 'category_ids=' . ($categoryIds ? implode(',', $categoryIds) : 'all') . "\n"
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
        // Require the strongest topic words so one generic term cannot flood results.
        $requiredWords = array_slice($top, 0, min(4, max(2, count($top))));

        return [
            'natural'  => implode(' ', $top),
            'boolean'  => implode(' ', array_map(
                fn($w) => strlen($w) >= 3 ? $w . '*' : $w,
                $top
            )),
            // Required boolean: each significant word must appear (+term*).
            'required' => implode(' ', array_map(
                fn($w) => strlen($w) >= 3 ? '+' . $w . '*' : '+' . $w,
                $requiredWords
            )),
            // Typo-tolerant boolean pass: prefix wildcards so a misspelled
            // ending ("proceduer") still matches the indexed word ("procedure").
            'fuzzy'    => implode(' ', array_map(
                fn($w) => strlen($w) >= 6
                    ? substr($w, 0, max(4, strlen($w) - 3)) . '*'
                    : (strlen($w) >= 3 ? $w . '*' : $w),
                $top
            )),
            'keywords' => array_slice($top, 0, 5),
        ];
    }

    private function searchChunks(string $expr, ?array $categoryIds, int $limit, string $mode): array {
        if ($expr === '') {
            return [];
        }

        $modeSql     = $mode === 'boolean' ? 'BOOLEAN MODE' : 'NATURAL LANGUAGE MODE';
        [$categorySql, $categoryBinds] = $this->categoryFilterSql($categoryIds);
        $binds       = array_merge([$expr, $expr], $categoryBinds);
        $binds[] = $limit;

        try {
            return Database::query(
                "SELECT dc.document_id, dc.page_number, dc.content,
                        d.title, d.mime_type, d.category_id, c.name AS category_name,
                        MATCH(dc.content) AGAINST (? IN $modeSql) AS score
                 FROM document_chunks dc
                 JOIN documents d ON d.id = dc.document_id AND d.status = 'ready'
                 JOIN categories c ON c.id = d.category_id
                 WHERE MATCH(dc.content) AGAINST (? IN $modeSql)
                 AND d.category_id IS NOT NULL
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

    /**
     * @param 'and'|'or' $mode
     */
    private function likeSearchChunks(array $keywords, ?array $categoryIds, int $limit, string $mode = 'and'): array {
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

        // Prefer AND across the top topic words; fall back to OR only when asked.
        $joiner = $mode === 'or' ? ' OR ' : ' AND ';
        // For AND, require at least the first 2–3 keywords so rare queries still match.
        if ($mode === 'and' && count($likes) > 3) {
            $likes = array_slice($likes, 0, 3);
            $binds = array_slice($binds, 0, 3);
        }

        [$categorySql, $categoryBinds] = $this->categoryFilterSql($categoryIds);
        foreach ($categoryBinds as $b) {
            $binds[] = $b;
        }
        $binds[] = $limit;

        return Database::query(
            'SELECT dc.document_id, dc.page_number, dc.content,
                    d.title, d.mime_type, d.category_id, c.name AS category_name, 1.0 AS score
             FROM document_chunks dc
             JOIN documents d ON d.id = dc.document_id AND d.status = \'ready\'
             JOIN categories c ON c.id = d.category_id
             WHERE (' . implode($joiner, $likes) . ")
             AND d.category_id IS NOT NULL
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
        $qTokens  = $this->significantQuestionTokens($question);

        foreach ($ranked as $chunk) {
            $content = trim((string) ($chunk['content'] ?? ''));
            if (mb_strlen($content) < 80) {
                continue;
            }
            if (DocumentParser::isTableOfContentsChunk($content)) {
                continue;
            }

            $score = (float) ($chunk['rerank_score'] ?? 0);
            if ($score < 0.25) {
                continue;
            }

            // Require real topic overlap — don't recover from a single shared word.
            $phrase = (float) ($chunk['phrase_score'] ?? ChunkReranker::phraseMatchScore($content, $question));
            $cover  = (float) ($chunk['coverage'] ?? ChunkReranker::topicCoverage($content, $question));
            if ($phrase < 0.55 && $cover < 0.6) {
                continue;
            }

            $answer = $this->extractRelevantPassage($content, $qTokens);
            if (mb_strlen($answer) < 40) {
                continue;
            }
            if (ChunkReranker::phraseMatchScore($answer, $question) < 0.4
                && ChunkReranker::topicCoverage($answer, $question) < 0.5) {
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

    /** @return array<int, string> */
    private function significantQuestionTokens(string $question): array {
        $stop = [
            'the','and','for','that','with','this','from','what','when','where',
            'which','who','how','why','does','did','are','was','were','have',
            'please','tell','explain','describe','define','about','into',
        ];
        $words = preg_split('/[^a-z0-9]+/i', strtolower($question)) ?: [];
        $tokens = [];
        foreach ($words as $w) {
            if (strlen($w) < 4 || in_array($w, $stop, true)) {
                continue;
            }
            $tokens[] = $w;
        }
        return array_values(array_unique($tokens));
    }

    /**
     * Pull a detailed passage around the sentences that best match the question.
     */
    private function extractRelevantPassage(string $content, array $qTokens): string {
        $normalized = trim(preg_replace('/\s+/u', ' ', $content) ?? $content);
        $units = preg_split(
            '/(?=\b[a-z]\)\s+)|(?<=[.!?])\s+(?=[A-Z(\[\d])/u',
            $normalized
        ) ?: [];
        $units = array_values(array_filter(array_map('trim', $units), fn($u) => mb_strlen($u) >= 12));
        if (empty($units)) {
            return mb_substr($normalized, 0, 1400);
        }

        $bestIdx = 0;
        $bestScore = -1.0;
        foreach ($units as $i => $unit) {
            $lower = strtolower($unit);
            $hits = 0;
            foreach ($qTokens as $token) {
                if (str_contains($lower, $token)) {
                    $hits++;
                }
            }
            $score = empty($qTokens) ? 0.0 : $hits / count($qTokens);
            if ($score > $bestScore) {
                $bestScore = $score;
                $bestIdx = $i;
            }
        }

        // Include a nearby section heading when present.
        $start = $bestIdx;
        for ($i = $bestIdx; $i >= max(0, $bestIdx - 3); $i--) {
            $u = $units[$i];
            if (preg_match('/^[a-z]\)\s+\S+/i', $u) && !preg_match('/[.!?]$/u', $u) && mb_strlen($u) < 160) {
                $start = $i;
                break;
            }
            if ($i === $bestIdx - 1 && mb_strlen($u) < 220) {
                $start = $i;
            }
        }

        $parts = [];
        $length = 0;
        $count = count($units);
        for ($i = $start; $i < $count; $i++) {
            $unit = $units[$i];

            // Stop at the next major heading after we already have content.
            if (
                $i > $bestIdx
                && count($parts) >= 2
                && preg_match('/^[a-z]\)\s+\S+/i', $unit)
                && !preg_match('/[.!?]|(See\s+HSEQ|Procedure|–|-)/i', $unit)
                && mb_strlen($unit) < 120
            ) {
                break;
            }

            $next = $length + mb_strlen($unit) + (empty($parts) ? 0 : 1);
            if (!empty($parts) && $next > 1400) {
                break;
            }
            $parts[] = $unit;
            $length = $next;

            // After matching content, keep following list items then stop.
            if ($i > $bestIdx && $length >= 450 && preg_match('/^[a-z]\)\s+/i', $unit)) {
                $following = $units[$i + 1] ?? null;
                if ($following === null || !preg_match('/^[a-z]\)\s+/i', $following)) {
                    break;
                }
            }
        }

        $answer = $this->formatAnswerBlocks($parts);
        if ($answer !== '' && !preg_match('/[.!?…]$/u', trim($answer))) {
            $answer .= '.';
        }
        return $answer;
    }

    /**
     * Format heading / paragraph / list items on separate lines for readable chat replies.
     *
     * @param array<int, string> $parts
     */
    private function formatAnswerBlocks(array $parts): string {
        $cleaned = array_values(array_filter(array_map(
            fn($p) => trim(preg_replace('/\s+/u', ' ', $p) ?? $p),
            $parts
        )));
        if (empty($cleaned)) {
            return '';
        }
        if (count($cleaned) === 1) {
            return $cleaned[0];
        }

        $isHeading = function (string $t): bool {
            if (mb_strlen($t) < 8 || mb_strlen($t) > 160) {
                return false;
            }
            return (bool) (
                preg_match('/^[a-z]\)\s+\S+/i', $t)
                && !preg_match('/[.!?]$/u', $t)
                && !preg_match('/(See\s+|–|—)/u', $t)
                && mb_strlen($t) < 120
            );
        };
        $isListItem = function (string $t) use ($isHeading): bool {
            if (!preg_match('/^[a-z]\)\s+/i', $t)) {
                return false;
            }
            if ($isHeading($t)) {
                return false;
            }
            return (bool) (
                preg_match('/(See\s+|–|—)/u', $t)
                || preg_match('/[.!?]$/u', $t)
                || mb_strlen($t) >= 80
            );
        };

        $lines = [];
        foreach ($cleaned as $i => $unit) {
            $prev = $i > 0 ? $cleaned[$i - 1] : '';

            if ($isHeading($unit)) {
                if (!empty($lines)) {
                    $lines[] = '';
                }
                $lines[] = $unit;
                continue;
            }

            if ($isListItem($unit) || preg_match('/^[a-z]\)\s+/i', $unit)) {
                if (
                    !empty($lines)
                    && $prev !== ''
                    && !$isListItem($prev)
                    && !preg_match('/^[a-z]\)\s+/i', $prev)
                ) {
                    $lines[] = '';
                }
                $lines[] = $unit;
                continue;
            }

            if (
                !empty($lines)
                && ($isHeading($prev) || $isListItem($prev) || preg_match('/^[a-z]\)\s+/i', $prev) || mb_strlen($prev) > 120)
            ) {
                $lines[] = '';
            }
            $lines[] = $unit;
        }

        $text = trim(implode("\n", $lines));
        return preg_replace("/\n{3,}/", "\n\n", $text) ?? $text;
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
