<?php
// auth.php - session bootstrap + auth guards + current user
// NOTE: must be included BEFORE any HTML output (it starts the session
// and may send redirect headers). Pages include this right after functions.php.
require_once __DIR__ . '/db.php';

if (session_status() === PHP_SESSION_NONE) {
    if (!headers_sent()) {
        // Secure cookie: HttpOnly + SameSite=Lax; Secure flag only when the
        // request actually arrives over HTTPS (tunnel/production), so local
        // http://localhost keeps working during development.
        $isHttps = (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
            || (($_SERVER['SERVER_PORT'] ?? '') == 443);
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => $isHttps,
        ]);
        session_start();
    }
}

function current_user() {
    if (empty($_SESSION['user_id'])) return null;
    static $u = false;
    if ($u !== false) return $u ?: null;
    $pdo = db_connect();
    $stmt = $pdo->prepare('SELECT id, full_name, username, email, phone, display_name, is_manager, is_limited, avatar_color, avatar, last_activity
                           FROM users WHERE id = ?');
    $stmt->execute([$_SESSION['user_id']]);
    $u = $stmt->fetch();
    return $u ?: null;
}

/**
 * Establish the login session safely: regenerate the session id to prevent
 * session fixation, then set user_id. Call after verifying credentials.
 */
function establish_login_session($userId) {
    if (session_status() === PHP_SESSION_ACTIVE && !headers_sent()) {
        session_regenerate_id(true);
    }
    $_SESSION['user_id'] = (int)$userId;
}

// Redirect to login if not authenticated (for internal pages)
// Works even if some output already went out: falls back to a JS/meta redirect.
function require_login() {
    if (current_user() === null) {
        if (!headers_sent()) {
            header('Location: ' . base_url() . '/index.php');
            exit;
        } else {
            echo '<script>location.replace(' . json_encode(base_url() . '/index.php') . ');</script>';
        }
        exit;
    }
}

// API guard: returns JSON error instead of redirect
function require_login_api() {
    if (current_user() === null) {
        json_out(['ok' => false, 'msg' => 'احراز هویت نشده'], 401);
    }
}
