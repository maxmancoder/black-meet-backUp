<?php
// functions.php - shared helpers: config, csrf, otp, token, escaping

function app_config() {
    static $cfg = null;
    if ($cfg === null) {
        $cfg = json_decode(file_get_contents(__DIR__ . '/config.json'), true);
    }
    return $cfg;
}

function socket_url() {
    // Empty = same origin (works behind a tunnel/proxy that forwards /socket.io to the signaling server)
    return '';
}

function turn_config() {
    $c = app_config();
    $t = $c['turn'] ?? null;
    $servers = [
        ['urls' => 'stun:stun.l.google.com:19302'],
        ['urls' => 'stun:stun1.l.google.com:19302'],
    ];
    // Local TURN relay exposed through a public TCP tunnel (bore), so it is
    // reachable by both peers regardless of their NAT. Preferred.
    $hostFile = __DIR__ . '/turn_host.txt';
    if (!empty($t['user']) && !empty($t['pass']) && file_exists($hostFile)) {
        $line = trim(file_get_contents($hostFile));
        $line = str_replace("\xEF\xBB\xBF", '', $line);
        $th = null; $tp = 3478;
        if (preg_match('/^([^:]+):(\d+)$/', $line, $m)) { $th = $m[1]; $tp = (int)$m[2]; }
        elseif ($line !== '') { $th = $line; }
        if ($th) {
            $servers[] = [
                'urls' => 'turn:' . $th . ':' . $tp . '?transport=tcp',
                'username' => $t['user'],
                'credential' => $t['pass'],
            ];
        }
    }
    // Public open-relay fallback (no credentials required)
    // UDP first (fastest relay path), then TCP variants for restrictive NATs.
    // NOTE: a turn: URL WITHOUT username+credential throws InvalidAccessError in
    // Chrome and kills the whole RTCPeerConnection — always supply both.
    $servers[] = ['urls' => 'turn:openrelay.metered.ca:3478', 'username' => 'openrelayproject', 'credential' => 'openrelayproject'];
    $servers[] = ['urls' => 'turn:openrelay.metered.ca:443?transport=tcp', 'username' => 'openrelayproject', 'credential' => 'openrelayproject'];
    $servers[] = ['urls' => 'turn:openrelay.metered.ca:80?transport=tcp', 'username' => 'openrelayproject', 'credential' => 'openrelayproject'];
    return $servers;
}

function base_url() {
    // Derive from the incoming request so it works both locally (localhost)
    // and behind a public tunnel (friend uses the real host + https).
    $host = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? null);
    if ($host) {
        $proto = 'http';
        if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
            $proto = strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']);
        } elseif (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') {
            $proto = 'https';
        } elseif (($p = $_SERVER['SERVER_PORT'] ?? null) && $p == 443) {
            $proto = 'https';
        } else {
            // Behind a public tunnel: friend reaches us over https.
            $h = strtolower($host);
            if ($h !== 'localhost' && $h !== '127.0.0.1' && $h !== '::1') {
                $proto = 'https';
            }
        }
        return rtrim($proto . '://' . $host . '/black-meet', '/');
    }
    $c = app_config();
    return rtrim($c['base_url'], '/');
}

// Public URL of the site as seen from outside, read from tunnel_url.txt
// (kept up to date by keep-tunnel.ps1). Falls back to base_url().
function public_url() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $file = __DIR__ . '/tunnel_url.txt';
    if (file_exists($file)) {
        $u = trim(file_get_contents($file));
        $u = str_replace("\xEF\xBB\xBF", '', $u);
        if ($u !== '' && preg_match('#^https?://#i', $u)) {
            return $cached = rtrim($u, '/');
        }
    }
    return $cached = base_url();
}

// ---- CSRF ----
function csrf_token() {
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function csrf_valid($token) {
    return isset($_SESSION['csrf']) && is_string($token)
        && hash_equals($_SESSION['csrf'], $token);
}

// ---- OTP ----
function generate_otp($len = 6) {
    $otp = '';
    for ($i = 0; $i < $len; $i++) $otp .= random_int(0, 9);
    return $otp;
}

// ---- Secure token (HMAC) for socket auth ----
function make_socket_token($user_id, $meeting_id) {
    $c = app_config();
    $payload = $user_id . '|' . $meeting_id . '|' . time();
    $sig = hash_hmac('sha256', $payload, $c['secret']);
    return $payload . '.' . $sig;
}

function verify_socket_token($token, &$out = []) {
    $c = app_config();
    $parts = explode('.', $token, 2);
    if (count($parts) !== 2) return false;
    $payload = $parts[0];
    $sig = $parts[1];
    $expected = hash_hmac('sha256', $payload, $c['secret']);
    if (!hash_equals($expected, $sig)) return false;
    $fields = explode('|', $payload);
    if (count($fields) !== 3) return false;
    if (time() - (int)$fields[2] > 86400) return false; // 24h
    $out = ['user_id' => (int)$fields[0], 'meeting_id' => (int)$fields[1]];
    return true;
}

// ---- Output escaping (XSS) ----
function e($str) {
    return htmlspecialchars($str ?? '', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

// ---- Asset URL with cache-busting (mtime version) ----
// Apache caches JS/CSS for a week; without ?v= users keep running stale code
// after every deploy — which looked like "changes not taking effect".
function asset_url($path) {
    $file = __DIR__ . '/' . ltrim($path, '/');
    $v = @filemtime($file);
    return base_url() . '/' . ltrim($path, '/') . ($v ? '?v=' . $v : '');
}

function to_fa_digits($num) {
    $map = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
    return strtr((string)$num, array_combine(range(0,9), $map));
}

// ---- JSON response helper ----
function json_out($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// ---- Random public room id ----
function generate_room_id($len = 16) {
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    $out = '';
    for ($i = 0; $i < $len; $i++) $out .= $chars[random_int(0, strlen($chars) - 1)];
    return $out;
}

// ---- Avatar initials ----
function initials($name) {
    $parts = preg_split('/\s+/u', trim($name));
    if (count($parts) >= 2) return mb_substr($parts[0], 0, 1) . mb_substr($parts[1], 0, 1);
    return mb_substr($name, 0, 2);
}

// ---- On-the-fly schema patch (adds is_limited if missing) ----
// PHASE 0 NOTE: these runtime patches are now NO-OPs. All schema objects are
// created by sql/migrations/001_phase0_schema.sql (applied once out-of-band).
// Kept as empty functions so existing call sites keep working until Phase 1.
function ensure_users_limited_column() { /* moved to sql/migrations/001 */ }

function ensure_schema_extras() { /* moved to sql/migrations/001 */ }

function ensure_manager_password_hashed() { /* migration handled by tools/migrate_passwords.php */ }

// ---- Avatar URL helper ----
function avatar_url($avatar) {
    if (!$avatar) return '';
    if (preg_match('#^https?://#i', $avatar)) return $avatar;
    return rtrim(base_url(), '/') . '/' . ltrim($avatar, '/');
}
