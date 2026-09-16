<?php
require_once __DIR__ . '/../functions.php';
ensure_schema_extras();

header('Content-Type: application/json; charset=utf-8');
session_start();
require_once __DIR__ . '/../auth.php';
require_login_api();

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->query('SELECT id, body, created_at FROM announcements ORDER BY id DESC');
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode(['ok' => true, 'announcements' => $rows]);
    exit;
}

if ($method === 'POST') {
    $me = current_user();
    if (empty($me['is_manager'])) { echo json_encode(['ok' => false, 'msg' => 'فقط مدیر']); exit; }
    $body = trim($_POST['body'] ?? '');
    if (!csrf_valid($_POST['csrf'] ?? '')) { echo json_encode(['ok' => false, 'msg' => 'CSRF']); exit; }
    if ($body === '') { echo json_encode(['ok' => false, 'msg' => 'متن خالی است']); exit; }
    $stmt = $pdo->prepare('INSERT INTO announcements (body, created_at) VALUES (?, NOW())');
    $stmt->execute([$body]);
    // Push instantly to every open page via the live channel
    try {
        $c = app_config();
        $ch = curl_init('http://localhost:' . ($c['socket_port'] ?? 3000) . '/__broadcast');
        curl_setopt_array($ch, [
            CURLOPT_POST => 1,
            CURLOPT_POSTFIELDS => json_encode(['room' => 'announcements', 'event' => 'announcements', 'data' => ['body' => $body, 'created_at' => date('Y-m-d H:i:s')]]),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT => 2,
        ]);
        curl_exec($ch); curl_close($ch);
    } catch (Exception $e) { /* non-fatal */ }
    echo json_encode(['ok' => true]);
    exit;
}

echo json_encode(['ok' => false, 'msg' => 'متد نامعتبر']);
