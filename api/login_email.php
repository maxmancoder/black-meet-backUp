<?php
// api/login_email.php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../security.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_out(['ok' => false, 'msg' => 'متد نامعتبر'], 405);
if (!csrf_valid($_POST['csrf'] ?? '')) json_out(['ok' => false, 'msg' => 'درخواست نامعتبر'], 403);

$email = trim($_POST['email'] ?? '');
$pass  = $_POST['password'] ?? '';

$pdo = db_connect();
$stmt = $pdo->prepare('SELECT id, password_hash FROM users WHERE email=?');
$stmt->execute([$email]);
$user = $stmt->fetch();

if (!$user) {
    json_out(['ok' => false, 'msg' => 'حساب وجود ندارد']);
}

[$ok, $upgradeHash] = verify_and_upgrade_password($pass, (string)$user['password_hash']);

if (!$ok) {
    json_out(['ok' => false, 'msg' => 'حساب وجود ندارد']);
}

// Transparent migration: legacy plaintext -> bcrypt on first successful login.
if ($upgradeHash !== null) {
    try { store_upgraded_password($pdo, $user['id'], $upgradeHash); } catch (\Throwable $e) {}
}

establish_login_session($user['id']);
json_out(['ok' => true, 'redirect' => base_url() . '/home.php']);
