<?php
// api/verify_otp.php  (shared by signup + login_phone)
require_once __DIR__ . '/../auth.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(['ok' => false, 'msg' => 'متد نامعتبر'], 405);
if (!csrf_valid($_POST['csrf'] ?? '')) json_out(['ok' => false, 'msg' => 'درخواست نامعتبر'], 403);

$phone   = trim($_POST['phone'] ?? '');
$code    = trim($_POST['code'] ?? '');
$purpose = $_POST['purpose'] === 'signup' ? 'signup' : 'login_phone';

if ($phone === '' || $code === '') json_out(['ok' => false, 'msg' => 'داده ناقص']);

$pdo = db_connect();

// Find the latest code for this phone number (any purpose)
$stmt = $pdo->prepare('SELECT code FROM verification_codes
                       WHERE identifier=?
                       ORDER BY id DESC LIMIT 1');
$stmt->execute([$phone]);
$row = $stmt->fetch();
if (!$row) {
    json_out(['ok' => false, 'msg' => 'کد تاییدی برای این شماره وجود ندارد. لطفاً ابتدا کد تایید را دریافت کنید.']);
}
if (!hash_equals((string)$row['code'], (string)$code)) {
    json_out(['ok' => false, 'msg' => 'کد تایید اشتباه است.']);
}

// Verification succeeded.
// NOTE: the code is NOT deleted here. It is deleted later when the user
// actually enters the main page (home.php).

$stmt = $pdo->prepare('SELECT id FROM users WHERE phone=?');
$stmt->execute([$phone]);
$user = $stmt->fetch();
if (!$user) json_out(['ok' => false, 'msg' => 'حساب یافت نشد']);

$_SESSION['user_id'] = $user['id'];
json_out(['ok' => true, 'redirect' => base_url() . '/home.php']);
