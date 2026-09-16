<?php
// api/announcements.php
require_once __DIR__ . '/../functions.php';
require_once __DIR__ . '/../security.php';
require_once __DIR__ . '/../auth.php';
require_login_api();

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db_connect();

if ($method === 'GET') {
    $stmt = $pdo->query('SELECT id, body, created_at FROM announcements ORDER BY id DESC');
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    json_out(['ok' => true, 'announcements' => $rows]);
}

if ($method === 'POST') {
    $me = current_user();
    if (empty($me['is_manager'])) json_out(['ok' => false, 'msg' => 'فقط مدیر'], 403);
    $body = trim($_POST['body'] ?? '');
    if (!csrf_valid($_POST['csrf'] ?? '')) json_out(['ok' => false, 'msg' => 'CSRF'], 403);
    if ($body === '') json_out(['ok' => false, 'msg' => 'متن خالی است']);

    $stmt = $pdo->prepare('INSERT INTO announcements (body, created_at) VALUES (?, NOW())');
    $stmt->execute([$body]);
    $notifId = (int)$pdo->lastInsertId();

    // Push instantly via the unified realtime channel (notif:new → all authed users;
    // bm:announcements → pages subscribed to the announcements broadcast room)
    $notif = ['id' => $notifId, 'body' => $body, 'created_at' => date('Y-m-d H:i:s')];
    broadcast_to_node('announcements', 'notif:new', $notif);

    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => 'متد نامعتبر'], 405);
