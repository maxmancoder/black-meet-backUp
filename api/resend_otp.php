<?php
// api/resend_otp.php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../security.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(['ok' => false, 'msg' => 'متد نامعتبر'], 405);
if (!csrf_valid($_POST['csrf'] ?? '')) json_out(['ok' => false, 'msg' => 'درخواست نامعتبر'], 403);

$phone   = trim($_POST['phone'] ?? '');
$purpose = $_POST['purpose'] === 'signup' ? 'signup' : 'login_phone';
if (!preg_match('/^[0-9]{10,15}$/', $phone)) json_out(['ok' => false, 'msg' => 'شماره نامعتبر است']);

$pdo = db_connect();

// Rate limit: max 5 OTP generations per 15 minutes per phone
if (!otp_send_allowed($pdo, $phone)) {
    json_out(['ok' => false, 'msg' => 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید']);
}

otp_cleanup($pdo, $phone);

$code = generate_otp();
// expires_at computed by MySQL (NOW()) — PHP/MySQL clocks may disagree (tz mismatch),
// and expiry checks + cleanup run on the MySQL side.
$pdo->prepare('INSERT INTO verification_codes (identifier,code,purpose,expires_at) VALUES (?,?,?, (NOW() + INTERVAL 5 MINUTE))')
    ->execute([$phone, $code, $purpose]);
$pdo->prepare('DELETE FROM verification_codes WHERE identifier=? AND purpose=? AND created_at < (NOW() - INTERVAL 15 MINUTE)')
    ->execute([$phone, $purpose]);

dev_log_otp($phone, $code, 'resend_' . $purpose);

$response = ['ok' => true, 'msg' => 'کد جدید ارسال شد'];
// OTP is exposed ONLY in dev mode (config.json "DEV_MODE": true)
if (is_dev_mode()) {
    $response['otp'] = $code;
}
json_out($response);
