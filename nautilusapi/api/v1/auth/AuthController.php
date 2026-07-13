<?php
// backend/api/v1/auth/AuthController.php

require_once __DIR__ . '/../../../core/Database.php';
require_once __DIR__ . '/../../../core/Response.php';
require_once __DIR__ . '/../../../core/Request.php';
require_once __DIR__ . '/../../../core/JWT.php';
require_once __DIR__ . '/../../../core/Logger.php';
require_once __DIR__ . '/../../../services/MailService.php';

class AuthController {

    public function register(array $params = []): void {
        $errors = Request::validate([
            'name'     => 'required|min:2|max:150',
            'email'    => 'required|email',
            'password' => 'required|min:8|max:255',
        ]);

        if ($errors) {
            Response::error('Validation failed', 422, $errors);
            return;
        }

        $name     = trim(Request::post('name'));
        $email    = strtolower(trim(Request::post('email')));
        $password = Request::post('password');

        // Check email taken
        if (Database::queryOne('SELECT id FROM users WHERE email = ?', [$email])) {
            Response::error('Email already registered', 409);
            return;
        }

        $hash  = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        $token = bin2hex(random_bytes(32));

        $userId = Database::insert(
            'INSERT INTO users (name, email, password, email_verification_token) VALUES (?, ?, ?, ?)',
            [$name, $email, $hash, $token]
        );

        // Send verification email (non-blocking; if it fails, log and continue)
        try {
            MailService::sendVerification($email, $name, $token);
        } catch (Exception $e) {
            Logger::error("Email send failed for $email: " . $e->getMessage());
        }

        Response::success(
            ['user_id' => (int) $userId],
            'Registration successful. Please verify your email.',
            201
        );
    }

    public function login(array $params = []): void {
        $errors = Request::validate([
            'email'    => 'required|email',
            'password' => 'required',
        ]);

        if ($errors) {
            Response::error('Validation failed', 422, $errors);
            return;
        }

        $email    = strtolower(trim(Request::post('email')));
        $password = Request::post('password');

        $user = Database::queryOne(
            'SELECT * FROM users WHERE email = ?',
            [$email]
        );

        if (!$user || !password_verify($password, $user['password'])) {
            Response::error('Invalid credentials', 401);
            return;
        }

        if (!$user['email_verified_at']) {
            Response::error('Please verify your email before logging in', 403);
            return;
        }

        if (!$user['is_active']) {
            Response::error('Your account has been deactivated', 403);
            return;
        }

        // Generate JWT and store token
        $token = bin2hex(random_bytes(32));
        $jwt   = JWT::generate(['user_id' => $user['id'], 'role' => $user['role'], 'token' => $token]);

        $cfg = require __DIR__ . '/../../../config/config.php';
        Database::insert(
            'INSERT INTO api_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
            [$user['id'], $token, $cfg['jwt']['expiry']]
        );

        Response::success([
            'token' => $jwt,
            'user'  => [
                'id'    => (int) $user['id'],
                'name'  => $user['name'],
                'email' => $user['email'],
                'role'  => $user['role'],
            ]
        ]);
    }

    public function logout(array $params = []): void {
        $token = Request::bearerToken();
        if ($token) {
            $payload = JWT::verify($token);
            if ($payload) {
                Database::execute('DELETE FROM api_tokens WHERE token = ?', [$payload['token']]);
            }
        }
        Response::success(null, 'Logged out');
    }

    public function verifyEmail(array $params = []): void {
        $token = Request::post('token') ?? Request::get('token');
        if (!$token) {
            Response::error('Token required', 400);
            return;
        }

        $user = Database::queryOne(
            'SELECT id FROM users WHERE email_verification_token = ?',
            [$token]
        );

        if (!$user) {
            Response::error('Invalid or expired verification token', 400);
            return;
        }

        Database::execute(
            'UPDATE users SET email_verified_at = NOW(), email_verification_token = NULL WHERE id = ?',
            [$user['id']]
        );

        Response::success(null, 'Email verified successfully');
    }

    public function forgotPassword(array $params = []): void {
        $email = strtolower(trim(Request::post('email') ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            Response::error('Valid email required', 400);
            return;
        }

        $user = Database::queryOne('SELECT id, name FROM users WHERE email = ?', [$email]);

        // Always return success to prevent email enumeration
        if ($user) {
            $token = bin2hex(random_bytes(32));
            Database::execute(
                'UPDATE users SET reset_token = ?, reset_token_expires_at = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
                [$token, $user['id']]
            );
            try {
                MailService::sendPasswordReset($email, $user['name'], $token);
            } catch (Exception $e) {
                Logger::error("Reset email failed for $email: " . $e->getMessage());
            }
        }

        Response::success(null, 'If that email exists, a reset link has been sent');
    }

    public function resetPassword(array $params = []): void {
        $errors = Request::validate([
            'token'    => 'required',
            'password' => 'required|min:8',
        ]);

        if ($errors) {
            Response::error('Validation failed', 422, $errors);
            return;
        }

        $token    = Request::post('token');
        $password = Request::post('password');

        $user = Database::queryOne(
            'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires_at > NOW()',
            [$token]
        );

        if (!$user) {
            Response::error('Invalid or expired reset token', 400);
            return;
        }

        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        Database::execute(
            'UPDATE users SET password = ?, reset_token = NULL, reset_token_expires_at = NULL WHERE id = ?',
            [$hash, $user['id']]
        );

        // Revoke all tokens
        Database::execute('DELETE FROM api_tokens WHERE user_id = ?', [$user['id']]);

        Response::success(null, 'Password reset successfully');
    }

    public function me(array $params = []): void {
        $user = AuthMiddleware::require();
        Response::success([
            'id'    => (int) $user['id'],
            'name'  => $user['name'],
            'email' => $user['email'],
            'role'  => $user['role'],
        ]);
    }
}
