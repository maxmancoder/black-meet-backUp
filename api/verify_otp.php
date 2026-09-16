<?php
// api/verify_otp.php  (shared by signup + login_phone)
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../security.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(['ok' => false, 'msg' => 'متد نامعتبر'], 405);
if (!csrf_valid($_POST['csrf'] ?? '')) json_out(['ok' => false, 'msg' => 'درخواست نامعتبر'], 403);

$phone   = trim($_POST['phone'] ?? '');
$code    = trim($_POST['code'] ?? '');
$purpose = $_POST['purpose'] === 'signup' ? 'signup' : 'login_phone';

if ($phone === '' || $code === '') json_out(['ok' => false, 'msg' => 'داده ناقص']);

$pdo = db_connect();

// Brute-force protection: max 6 failed attempts per 15 minutes
if (!otp_verify_allowed($pdo, $phone)) {
    json_out(['ok' => false, 'msg' => 'تلاش‌های ناموفق زیاد است. لطفاً ۱۵ دقیقه صبر کنید'], 429);
}

// Find the latest code for this phone number + purpose
$stmt = $pdo->prepare('SELECT code, expires_at FROM verification_codes
                       WHERE identifier=? AND purpose=?
                       ORDER BY id DESC LIMIT 1');
$stmt->execute([$phone, $purpose]);
$row = $stmt->fetch();
if (!$row) {
    otp_record_failure($pdo, $phone);
    json_out(['ok' => false, 'msg' => 'کد تاییدی برای این شماره وجود ندارد. لطفاً ابتدا کد تایید را دریافت کنید.']);
}
// Expiry checked in PHP to avoid PHP/MySQL timezone mismatch
if (strtotime($row['expires_at']) <= time()) {
    otp_record_failure($pdo, $phone);
    json_out(['ok' => false, 'msg' => 'کد تأیید منقضی شده است. لطفاً کد جدید دریافت کنید.']);
}
if (!hash_equals((string)$row['code'], (string)$code)) {
    otp_record_failure($pdo, $phone);
    json_out(['ok' => false, 'msg' => 'کد تایید اشتباه است.']);
}

// Consume the code: one-time use (prevents replay)
$pdo->prepare('DELETE FROM verification_codes WHERE identifier=? AND purpose=?')
    ->execute([$phone, $purpose]);

$stmt = $pdo->prepare('SELECT id FROM users WHERE phone=?');
$stmt->execute([$phone]);
$user = $stmt->fetch();
if (!$user) json_out(['ok' => false, 'msg' => 'حساب یافت نشد']);

establish_login_session($user['id']);
json_out(['ok' => true, 'redirect' => base_url() . '/home.php']);
