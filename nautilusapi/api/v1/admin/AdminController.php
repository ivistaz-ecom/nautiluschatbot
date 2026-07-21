<?php
// backend/api/v1/admin/AdminController.php

require_once __DIR__ . '/../../../middleware/AuthMiddleware.php';

class AdminController {

    // ══ CATEGORIES ══════════════════════════════════════════════════

    public function categoriesIndex(array $params = []): void {
        AuthMiddleware::requireAdmin();
        $rows = Database::query(
            'SELECT c.*, p.name AS parent_name,
                    (SELECT COUNT(*) FROM documents d WHERE d.category_id = c.id) AS doc_count
             FROM categories c
             LEFT JOIN categories p ON p.id = c.parent_id
             ORDER BY c.sort_order ASC, c.name ASC'
        );
        Response::success($rows);
    }

    public function categoriesCreate(array $params = []): void {
        AuthMiddleware::requireAdmin();
        $errors = Request::validate(['name' => 'required|min:2|max:100']);
        if ($errors) { Response::error('Validation failed', 422, $errors); return; }

        $name      = trim(Request::post('name'));
        $slug      = $this->makeSlug($name);
        $desc      = trim(Request::post('description') ?? '');
        $parentId  = Request::post('parent_id') ? (int) Request::post('parent_id') : null;
        $sortOrder = (int) (Request::post('sort_order') ?? 0);

        // Ensure unique slug
        $existing = Database::queryOne('SELECT id FROM categories WHERE slug = ?', [$slug]);
        if ($existing) $slug .= '-' . time();

        $id = Database::insert(
            'INSERT INTO categories (name, slug, description, parent_id, sort_order) VALUES (?,?,?,?,?)',
            [$name, $slug, $desc, $parentId, $sortOrder]
        );

        Response::success(['id' => (int) $id], 'Category created', 201);
    }

    public function categoriesUpdate(array $params): void {
        AuthMiddleware::requireAdmin();
        $id = (int) ($params['id'] ?? 0);
        if (!Database::queryOne('SELECT id FROM categories WHERE id = ?', [$id])) {
            Response::error('Category not found', 404); return;
        }

        $name      = trim(Request::post('name') ?? '');
        $desc      = trim(Request::post('description') ?? '');
        $parentId  = Request::post('parent_id') ? (int) Request::post('parent_id') : null;
        $sortOrder = (int) (Request::post('sort_order') ?? 0);

        Database::execute(
            'UPDATE categories SET name=?, description=?, parent_id=?, sort_order=?, updated_at=NOW() WHERE id=?',
            [$name, $desc, $parentId, $sortOrder, $id]
        );
        Response::success(null, 'Category updated');
    }

    public function categoriesDelete(array $params): void {
        AuthMiddleware::requireAdmin();
        $id = (int) ($params['id'] ?? 0);

        $docCount = Database::queryOne('SELECT COUNT(*) AS c FROM documents WHERE category_id = ?', [$id])['c'];
        if ($docCount > 0) {
            Response::error("Cannot delete: category has $docCount documents", 409); return;
        }

        Database::execute('DELETE FROM categories WHERE id = ?', [$id]);
        Response::success(null, 'Category deleted');
    }

    // ══ USERS ════════════════════════════════════════════════════════

    public function usersIndex(array $params = []): void {
        AuthMiddleware::requireAdmin();
        ['page' => $page, 'perPage' => $perPage, 'offset' => $offset] = Request::paginate();

        $search = Request::get('search') ?? '';
        $role   = Request::get('role') ?? '';

        $where = ['1=1'];
        $binds = [];
        if ($search) { $where[] = '(name LIKE ? OR email LIKE ?)'; $binds[] = "%$search%"; $binds[] = "%$search%"; }
        if ($role)   { $where[] = 'role = ?'; $binds[] = $role; }

        $whereStr = implode(' AND ', $where);
        $total    = Database::queryOne("SELECT COUNT(*) AS c FROM users WHERE $whereStr", $binds)['c'];

        $rows = Database::query(
            "SELECT id, name, email, role, is_active, email_verified_at, created_at
             FROM users WHERE $whereStr ORDER BY created_at DESC LIMIT ? OFFSET ?",
            array_merge($binds, [$perPage, $offset])
        );

        Response::paginated($rows, (int) $total, $page, $perPage);
    }

    public function usersShow(array $params): void {
        AuthMiddleware::requireAdmin();
        $id   = (int) ($params['id'] ?? 0);
        $user = Database::queryOne(
            'SELECT id, name, email, role, is_active, email_verified_at, created_at FROM users WHERE id = ?',
            [$id]
        );

        if (!$user) { Response::error('User not found', 404); return; }

        $stats = Database::queryOne(
            'SELECT COUNT(DISTINCT s.id) AS sessions,
                    COUNT(m.id) AS messages
             FROM chat_sessions s
             LEFT JOIN chat_messages m ON m.session_id = s.id AND m.role = ?
             WHERE s.user_id = ?',
            ['user', $id]
        );

        $user['stats'] = $stats;
        Response::success($user);
    }

    public function usersToggle(array $params): void {
        AuthMiddleware::requireAdmin();
        $id = (int) ($params['id'] ?? 0);
        Database::execute('UPDATE users SET is_active = NOT is_active WHERE id = ?', [$id]);
        $user = Database::queryOne('SELECT id, is_active FROM users WHERE id = ?', [$id]);
        Response::success($user, $user['is_active'] ? 'User activated' : 'User deactivated');
    }

    // ══ WHITELIST ════════════════════════════════════════════════════

    public function whitelistIndex(array $params = []): void {
        AuthMiddleware::requireAdmin();
        $rows = Database::query(
            'SELECT w.*, u.name AS created_by_name FROM whitelisted_urls w JOIN users u ON u.id = w.created_by ORDER BY w.created_at DESC'
        );
        Response::success($rows);
    }

    public function whitelistCreate(array $params = []): void {
        $admin  = AuthMiddleware::requireAdmin();
        $errors = Request::validate(['origin' => 'required|min:5|max:255']);
        if ($errors) { Response::error('Validation failed', 422, $errors); return; }

        $origin = rtrim(trim(Request::post('origin')), '/');
        $note   = trim(Request::post('note') ?? '');

        if (!preg_match('#^https?://#i', $origin)) {
            Response::error('Origin must start with http:// or https://', 400); return;
        }

        if (Database::queryOne('SELECT id FROM whitelisted_urls WHERE origin = ?', [$origin])) {
            Response::error('Origin already whitelisted', 409); return;
        }

        $id = Database::insert(
            'INSERT INTO whitelisted_urls (origin, note, created_by) VALUES (?,?,?)',
            [$origin, $note, $admin['id']]
        );

        Response::success(['id' => (int) $id], 'Origin added to whitelist', 201);
    }

    public function whitelistDelete(array $params): void {
        AuthMiddleware::requireAdmin();
        $id = (int) ($params['id'] ?? 0);
        if (!Database::execute('DELETE FROM whitelisted_urls WHERE id = ?', [$id])) {
            Response::error('Entry not found', 404); return;
        }
        Response::success(null, 'Origin removed from whitelist');
    }

    public function whitelistToggle(array $params): void {
        AuthMiddleware::requireAdmin();
        $id = (int) ($params['id'] ?? 0);
        Database::execute('UPDATE whitelisted_urls SET is_active = NOT is_active WHERE id = ?', [$id]);
        Response::success(null, 'Whitelist entry toggled');
    }

    // ══ UNANSWERED QUERIES ═══════════════════════════════════════════

    public function queriesIndex(array $params = []): void {
        AuthMiddleware::requireAdmin();
        ['page' => $page, 'perPage' => $perPage, 'offset' => $offset] = Request::paginate();

        $status = Request::get('status') ?? 'open';
        $total  = Database::queryOne('SELECT COUNT(*) AS c FROM unanswered_queries WHERE status = ?', [$status])['c'];

        $rows = Database::query(
            'SELECT q.*, u.name AS user_name, u.email AS user_email,
                    a.name AS answered_by_name
             FROM unanswered_queries q
             JOIN users u ON u.id = q.user_id
             LEFT JOIN users a ON a.id = q.answered_by
             WHERE q.status = ?
             ORDER BY q.created_at DESC
             LIMIT ? OFFSET ?',
            [$status, $perPage, $offset]
        );

        Response::paginated($rows, (int) $total, $page, $perPage);
    }

    public function queriesAnswer(array $params): void {
        $admin  = AuthMiddleware::requireAdmin();
        $id     = (int) ($params['id'] ?? 0);
        $errors = Request::validate(['answer' => 'required|min:5']);
        if ($errors) { Response::error('Validation failed', 422, $errors); return; }

        $answer = trim(Request::post('answer'));

        $query = Database::queryOne('SELECT id, user_id FROM unanswered_queries WHERE id = ?', [$id]);
        if (!$query) { Response::error('Query not found', 404); return; }

        Database::execute(
            'UPDATE unanswered_queries SET admin_answer=?, answered_by=?, status=?, updated_at=NOW() WHERE id=?',
            [$answer, $admin['id'], 'answered', $id]
        );

        Response::success(null, 'Query answered');
    }

    public function queriesDelete(array $params = []): void {
        $admin = AuthMiddleware::requireAdmin();
        unset($admin);
        $id = (int) ($params['id'] ?? 0);

        $affected = Database::execute('DELETE FROM unanswered_queries WHERE id = ?', [$id]);
        if (!$affected) { Response::error('Query not found', 404); return; }

        Response::success(null, 'Query deleted');
    }

    // ══ ALL QUESTIONS ════════════════════════════════════════════════

    public function allQuestions(array $params = []): void {
        AuthMiddleware::requireAdmin();
        ['page' => $page, 'perPage' => $perPage, 'offset' => $offset] = Request::paginate();

        $userId     = Request::get('user_id');
        $categoryId = Request::get('category_id');
        $isAnswered = Request::get('is_answered');
        $dateFrom   = Request::get('date_from');
        $dateTo     = Request::get('date_to');

        $where = ["m.role = 'user'"];
        $binds = [];

        if ($userId)     { $where[] = 'm.user_id = ?';      $binds[] = (int) $userId; }
        if ($categoryId) { $where[] = 'm.category_id = ?';  $binds[] = (int) $categoryId; }
        if ($isAnswered !== null) { $where[] = 'm.is_answered = ?'; $binds[] = (int) $isAnswered; }
        if ($dateFrom)   { $where[] = 'm.created_at >= ?';  $binds[] = $dateFrom; }
        if ($dateTo)     { $where[] = 'm.created_at <= ?';  $binds[] = $dateTo; }

        $whereStr = implode(' AND ', $where);
        $total    = Database::queryOne("SELECT COUNT(*) AS c FROM chat_messages m WHERE $whereStr", $binds)['c'];

        $rows = Database::query(
            "SELECT m.id, m.question, m.is_answered, m.created_at,
                    u.name AS user_name, u.email AS user_email,
                    c.name AS category_name
             FROM chat_messages m
             JOIN users u ON u.id = m.user_id
             LEFT JOIN categories c ON c.id = m.category_id
             WHERE $whereStr
             ORDER BY m.created_at DESC
             LIMIT ? OFFSET ?",
            array_merge($binds, [$perPage, $offset])
        );

        Response::paginated($rows, (int) $total, $page, $perPage);
    }

    // ══ METRICS ══════════════════════════════════════════════════════

    public function metrics(array $params = []): void {
        AuthMiddleware::requireAdmin();

        $totalUsers    = Database::queryOne('SELECT COUNT(*) AS c FROM users WHERE role = ?', ['user'])['c'];
        $activeToday   = Database::queryOne(
            "SELECT COUNT(DISTINCT user_id) AS c FROM chat_sessions WHERE DATE(created_at) = CURDATE()"
        )['c'];
        $totalQs       = Database::queryOne("SELECT COUNT(*) AS c FROM chat_messages WHERE role = 'user'"  )['c'];
        $todayQs       = Database::queryOne("SELECT COUNT(*) AS c FROM chat_messages WHERE role = 'user' AND DATE(created_at) = CURDATE()"  )['c'];
        $unanswered    = Database::queryOne("SELECT COUNT(*) AS c FROM unanswered_queries WHERE status = 'open'"  )['c'];
        $newUsers30    = Database::queryOne("SELECT COUNT(*) AS c FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"  )['c'];

        $answerRate    = $totalQs > 0
            ? Database::queryOne(
                "SELECT ROUND(SUM(is_answered)/COUNT(*)*100, 1) AS r FROM chat_messages WHERE role = 'user'"
              )['r']
            : 0;

        $topCategories = Database::query(
            "SELECT c.name, COUNT(m.id) AS question_count
             FROM chat_messages m
             JOIN categories c ON c.id = m.category_id
             WHERE m.role = 'user' AND m.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY c.id ORDER BY question_count DESC LIMIT 5"
        );

        $topFaqs = Database::query(
            'SELECT canonical_question, ask_count FROM faqs ORDER BY ask_count DESC LIMIT 10'
        );

        $dailyActivity = Database::query(
            "SELECT DATE(created_at) AS date, COUNT(*) AS count
             FROM chat_messages WHERE role = 'user' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY DATE(created_at) ORDER BY date ASC"
        );

        Response::success([
            'total_users'       => (int) $totalUsers,
            'active_today'      => (int) $activeToday,
            'total_questions'   => (int) $totalQs,
            'questions_today'   => (int) $todayQs,
            'unanswered_open'   => (int) $unanswered,
            'new_users_30d'     => (int) $newUsers30,
            'answer_rate_pct'   => (float) $answerRate,
            'top_categories'    => $topCategories,
            'top_faqs'          => $topFaqs,
            'daily_activity'    => $dailyActivity,
        ]);
    }

    // ── Helpers ────────────────────────────────────────────────────
    private function makeSlug(string $text): string {
        $text = mb_strtolower($text);
        $text = preg_replace('/[^a-z0-9\s-]/', '', $text);
        $text = preg_replace('/[\s-]+/', '-', $text);
        return trim($text, '-');
    }
}
