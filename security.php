<?php
// security.php - centralized security helpers for Phase 0
// - App environment (DEV_MODE)
// - Password hashing/migration (bcrypt)
// - OTP rate limiting / brute force protection
// - Server-to-server broadcast auth (env secret)

require_once __DIR__ . '/functions.php';

/**
 * DEV_MODE: when true, OTP is returned in API responses and logged to a local
 * file (dev_otp.log) instead of being delivered by SMS. Controlled by the
 * DEV_MODE key in config.json. MUST be false in production.
 */
function is_dev_mode() {
    static $dev = null;
    if ($dev === null) {
        $c = app_config();
        $dev = !empty($c['DEV_MODE']);
    }
    return $dev;
}

/**
 * Log an OTP locally in dev mode only (never in production).
 */
function dev_log_otp($identifier, $code, $purpose) {
    if (!is_dev_mode()) return;
    $line = sprintf("[%s] %s | %s | %s\n", date('Y-m-d H:i:s'), $identifier, $purpose, $code);
    @file_put_contents(__DIR__ . '/dev_otp.log', $line, FILE_APPEND | LOCK_EX);
}

// ---------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------

/**
 * Create a secure password hash (bcrypt).
 */
function hash_password($plain) {
    return password_hash($plain, PASSWORD_BCRYPT);
}

/**
 * Verify a password. Transparently upgrades legacy plaintext / old formats
 * to bcrypt when the stored hash does not look like a modern hash.
 * Returns [bool ok, string|null newHash].
 */
function verify_and_upgrade_password($plain, $stored) {
    $stored = (string)$stored;

    // Already a bcrypt/argon hash: verify normally.
    if ($stored !== '' && (strpos($stored, '$2y$') === 0 || strpos($stored, '$2b$') === 0 || strpos($stored, '$argon') === 0)) {
        return [password_verify($plain, $stored), null];
    }

    // Legacy plaintext storage (insecure, kept only for migration).
    if (hash_equals($stored, $plain)) {
        return [true, hash_password($plain)];
    }

    // Legacy bcrypt variants that password_verify handles anyway.
    return [false, null];
}

/**
 * Persist an upgraded password hash for a user id.
 */
function store_upgraded_password($pdo, $userId, $newHash) {
    $pdo->prepare('UPDATE users SET password_hash=? WHERE id=?')
        ->execute([$newHash, $userId]);
}

// ---------------------------------------------------------------
// OTP security: rate limit + brute-force protection
// ---------------------------------------------------------------

/**
 * Rate limit OTP generation per identifier (phone).
 * Allows max 5 code generations per 15 minutes.
 */
function otp_send_allowed($pdo, $identifier) {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM verification_codes
                           WHERE identifier=? AND created_at > (NOW() - INTERVAL 15 MINUTE)');
    $stmt->execute([$identifier]);
    return ((int)$stmt->fetchColumn()) < 5;
}

/**
 * Brute-force protection for OTP verification per identifier.
 * Allows max 6 failed verify attempts per 15 minutes window (tracked via
 * failed codes stored with identifier prefix 'bf|' and purpose='login_phone'
 * sentinel rows — the enum column only allows signup/login_phone).
 */
function otp_verify_allowed($pdo, $identifier) {
    $key = 'bf|' . $identifier;
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM verification_codes
                           WHERE identifier=? AND created_at > (NOW() - INTERVAL 15 MINUTE)');
    $stmt->execute([$key]);
    return ((int)$stmt->fetchColumn()) < 6;
}

/**
 * Record a failed OTP verification attempt.
 */
function otp_record_failure($pdo, $identifier) {
    $key = 'bf|' . $identifier;
    $pdo->prepare('INSERT INTO verification_codes (identifier, code, purpose, expires_at)
                   VALUES (?, "x", "login_phone", (NOW() + INTERVAL 1 MINUTE))')
        ->execute([$key]);
}

/**
 * Clean expired verification rows for one identifier (housekeeping).
 */
function otp_cleanup($pdo, $identifier) {
    $pdo->prepare('DELETE FROM verification_codes
                   WHERE (identifier=? AND expires_at < (NOW() - INTERVAL 1 HOUR))
                      OR (identifier=? AND created_at < (NOW() - INTERVAL 15 MINUTE))')
        ->execute([$identifier, 'bf|' . $identifier]);
}

// ---------------------------------------------------------------
// Server-to-server broadcast auth (env secret)
// ---------------------------------------------------------------

/**
 * Shared secret for POST /__broadcast on the Node side, and for any PHP
 * component calling it. Read from environment variable BM_BROADCAST_SECRET
 * with config.json 'broadcast_secret' fallback (both set out of band).
 */
function broadcast_secret() {
    $env = getenv('BM_BROADCAST_SECRET');
    if ($env && $env !== '') return $env;
    $c = app_config();
    return $c['broadcast_secret'] ?? '';
}

/**
 * Notify the Node signaling server's /__broadcast endpoint.
 * Non-fatal on failure. Sends HMAC signature header for auth.
 */
function broadcast_to_node($room, $event, $data) {
    $secret = broadcast_secret();
    if ($secret === '') return; // not configured -> skip silently

    $c = app_config();
    $port = $c['socket_port'] ?? 3000;
    $payload = json_encode(['room' => $room, 'event' => $event, 'data' => $data]);
    $ts = (string)time();
    $sig = hash_hmac('sha256', $ts . '.' . $payload, $secret);

    $ch = curl_init('http://127.0.0.1:' . $port . '/__broadcast');
    curl_setopt_array($ch, [
        CURLOPT_POST => 1,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'X-BM-Timestamp: ' . $ts,
            'X-BM-Signature: ' . $sig,
        ],
        CURLOPT_TIMEOUT => 2,
        CURLOPT_RETURNTRANSFER => true, // keep curl_exec output out of the response body
    ]);
    curl_exec($ch);
    curl_close($ch);
}
