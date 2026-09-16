<?php
// api/signup.php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../security.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(['ok' => false, 'msg' => 'متد نامعتبر'], 405);
if (!csrf_valid($_POST['csrf'] ?? '')) json_out(['ok' => false, 'msg' => 'درخواست نامعتبر'], 403);

$full  = trim($_POST['full_name'] ?? '');
$user  = trim($_POST['username'] ?? '');
$email = trim($_POST['email'] ?? '');
$phone = trim($_POST['phone'] ?? '');
$pass  = $_POST['password'] ?? '';

if ($full === '' || $user === '' || $email === '' || $phone === '' || $pass === '') {
    json_out(['ok' => false, 'msg' => 'تمام فیلدها الزامی هستند']);
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) json_out(['ok' => false, 'msg' => 'ایمیل نامعتبر است']);
if (!preg_match('/^[0-9]{10,15}$/', $phone)) json_out(['ok' => false, 'msg' => 'شماره تلفن نامعتبر است']);
if (strlen($pass) < 6) json_out(['ok' => false, 'msg' => 'رمز عبور باید حداقل ۶ کاراکتر باشد']);

$pdo = db_connect();
$stmt = $pdo->prepare('SELECT id FROM users WHERE username=? OR email=? OR phone=?');
$stmt->execute([$user, $email, $phone]);
if ($stmt->fetch()) {
    json_out(['ok' => false, 'msg' => 'اطلاعات وارد شده تکراری میباشد']);
}

// Rate limit: max 5 OTP generations per 15 minutes per phone
if (!otp_send_allowed($pdo, $phone)) {
    json_out(['ok' => false, 'msg' => 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید']);
}

$hash = hash_password($pass); // bcrypt — plaintext storage removed
$display = $full;
$colors = ['#4f46e5', '#00a572', '#bf0f3c', '#c3c0ff', '#4edea3', '#ffb2b7'];
$avatarColor = $colors[array_rand($colors)];

$stmt = $pdo->prepare('INSERT INTO users (full_name,username,email,phone,password_hash,display_name,avatar_color)
                       VALUES (?,?,?,?,?,?,?)');
$stmt->execute([$full, $user, $email, $phone, $hash, $display, $avatarColor]);

// Generate OTP for phone verification
$code = generate_otp();
// expires_at computed by MySQL (NOW()) — PHP/MySQL clocks may disagree (tz mismatch).
// Insert FIRST, then prune older codes so the 15-min send rate-limit counter survives.
$pdo->prepare('INSERT INTO verification_codes (identifier,code,purpose,expires_at) VALUES (?,?,?, (NOW() + INTERVAL 5 MINUTE))')
    ->execute([$phone, $code, 'signup']);
$pdo->prepare('DELETE FROM verification_codes WHERE identifier=? AND purpose=? AND created_at < (NOW() - INTERVAL 15 MINUTE)')
    ->execute([$phone, 'signup']);

dev_log_otp($phone, $code, 'signup');

$response = [
    'ok'       => true,
    'phone'    => $phone,
    'purpose'  => 'signup',
    'msg'      => 'کد تأیید تولید شد'
];
// OTP is exposed ONLY in dev mode (config.json "DEV_MODE": true)
if (is_dev_mode()) {
    $response['otp'] = $code;
}

json_out($response);
