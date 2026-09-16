<?php
// api/internal.php — internal service API for the Node signaling server.
// Server-to-server only: HMAC-SHA256(ts + '.' + rawBody, BROADCAST_SECRET).
// Node calls these so participant actions and chat persistence go through
// ONE business-logic path (PHP+MySQL) and then Node broadcasts the result.
//
// POST body: JSON { action: '...', ...params }
// Responses: JSON { ok: true, ...data } | { ok: false, error: 'CODE' }
require_once __DIR__ . '/../functions.php';
require_once __DIR__ . '/../security.php';
require_once __DIR__ . '/../db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'BAD_METHOD']);
    exit;
}

// ---- server-to-server auth ----
$raw = file_get_contents('php://input');
$secret = broadcast_secret();
if ($secret === '') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'NOT_CONFIGURED']);
    exit;
}
$ts = $_SERVER['HTTP_X_BM_TIMESTAMP'] ?? '';
$sig = $_SERVER['HTTP_X_BM_SIGNATURE'] ?? '';
$expected = hash_hmac('sha256', $ts . '.' . $raw, $secret);
$tsOk = $ts !== '' && abs(time() - (int)$ts) < 300;
if (!$tsOk || $sig === '' || !hash_equals($expected, $sig)) {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'UNAUTHORIZED']);
    exit;
}

$in = json_decode($raw, true);
if (!is_array($in) || empty($in['action'])) {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'BAD_REQUEST']);
    exit;
}
$action = $in['action'];

$pdo = db_connect();

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
function internal_meeting(PDO $pdo, $roomId) {
    $s = $pdo->prepare('SELECT id, room_id, title, creator_id, active FROM meetings WHERE room_id=?');
    $s->execute([(string)$roomId]);
    return $s->fetch(PDO::FETCH_ASSOC) ?: null;
}

function internal_participant(PDO $pdo, $meetingId, $userId) {
    $s = $pdo->prepare('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?');
    $s->execute([(int)$meetingId, (int)$userId]);
    return $s->fetch(PDO::FETCH_ASSOC) ?: null;
}

function internal_user(PDO $pdo, $userId) {
    $s = $pdo->prepare('SELECT id, display_name, username, avatar_color, avatar, is_manager FROM users WHERE id=?');
    $s->execute([(int)$userId]);
    return $s->fetch(PDO::FETCH_ASSOC) ?: null;
}

/** A user is admin of the meeting if participants.role=admin (fallback: meetings.creator_id). */
function internal_is_meeting_admin(PDO $pdo, $meetingId, $userId) {
    $p = internal_participant($pdo, $meetingId, $userId);
    if ($p && $p['role'] === 'admin') return true;
    $m = $s = $pdo->prepare('SELECT creator_id FROM meetings WHERE id=?');
    $m->execute([(int)$meetingId]);
    $row = $m->fetch(PDO::FETCH_ASSOC);
    return $row && (int)$row['creator_id'] === (int)$userId;
}

header('Content-Type: application/json; charset=utf-8');

switch ($action) {

    // -----------------------------------------------------------
    // call:approve — approve a pending participant (idempotent)
    // -----------------------------------------------------------
    case 'call:approve': {
        $roomId = $in['room'] ?? ''; $actorId = (int)($in['actor_id'] ?? 0); $targetId = (int)($in['target_id'] ?? 0);
        $m = internal_meeting($pdo, $roomId);
        if (!$m) { echo json_encode(['ok' => false, 'error' => 'MEETING_NOT_FOUND']); break; }
        if (!internal_is_meeting_admin($pdo, $m['id'], $actorId)) { echo json_encode(['ok' => false, 'error' => 'NOT_AUTHORIZED']); break; }
        $p = internal_participant($pdo, $m['id'], $targetId);
        if (!$p) { echo json_encode(['ok' => false, 'error' => 'PARTICIPANT_NOT_FOUND']); break; }
        $pdo->prepare('UPDATE meeting_participants SET status=? WHERE id=?')->execute(['approved', $p['id']]);
        $u = internal_user($pdo, $targetId);
        echo json_encode(['ok' => true, 'member' => [
            'userId' => (int)$targetId,
            'name' => $u ? $u['display_name'] : (string)$p['display_name'],
            'username' => $u ? $u['username'] : (string)$p['username'],
            'avatar_color' => $u ? $u['avatar_color'] : '#4f46e5',
            'avatar' => $u ? (string)$u['avatar'] : '',
            'is_admin' => ($p['role'] === 'admin'),
            'status' => 'approved',
        ]]);
        break;
    }

    // -----------------------------------------------------------
    // call:reject / call:kick — mark removed in DB
    // -----------------------------------------------------------
    case 'call:reject':
    case 'call:kick': {
        $roomId = $in['room'] ?? ''; $actorId = (int)($in['actor_id'] ?? 0); $targetId = (int)($in['target_id'] ?? 0);
        $m = internal_meeting($pdo, $roomId);
        if (!$m) { echo json_encode(['ok' => false, 'error' => 'MEETING_NOT_FOUND']); break; }
        if (!internal_is_meeting_admin($pdo, $m['id'], $actorId)) { echo json_encode(['ok' => false, 'error' => 'NOT_AUTHORIZED']); break; }
        $p = internal_participant($pdo, $m['id'], $targetId);
        if (!$p) { echo json_encode(['ok' => false, 'error' => 'PARTICIPANT_NOT_FOUND']); break; }
        $pdo->prepare('UPDATE meeting_participants SET status=? WHERE id=?')->execute(['removed', $p['id']]);
        echo json_encode(['ok' => true, 'user_id' => (int)$targetId]);
        break;
    }

    // -----------------------------------------------------------
    // call:block — persist into meeting_blocks
    // -----------------------------------------------------------
    case 'call:block': {
        $roomId = $in['room'] ?? ''; $actorId = (int)($in['actor_id'] ?? 0); $targetId = (int)($in['target_id'] ?? 0);
        $m = internal_meeting($pdo, $roomId);
        if (!$m) { echo json_encode(['ok' => false, 'error' => 'MEETING_NOT_FOUND']); break; }
        if (!internal_is_meeting_admin($pdo, $m['id'], $actorId)) { echo json_encode(['ok' => false, 'error' => 'NOT_AUTHORIZED']); break; }
        $pdo->prepare('INSERT IGNORE INTO meeting_blocks (meeting_id, user_id) VALUES (?, ?)')
            ->execute([(int)$m['id'], $targetId]);
        $p = internal_participant($pdo, $m['id'], $targetId);
        if ($p) $pdo->prepare('UPDATE meeting_participants SET status=? WHERE id=?')->execute(['removed', $p['id']]);
        echo json_encode(['ok' => true, 'user_id' => $targetId]);
        break;
    }

    // -----------------------------------------------------------
    // call:leave — mark the leaver removed
    // -----------------------------------------------------------
    case 'call:leave': {
        $roomId = $in['room'] ?? ''; $actorId = (int)($in['actor_id'] ?? 0);
        $m = internal_meeting($pdo, $roomId);
        if (!$m) { echo json_encode(['ok' => false, 'error' => 'MEETING_NOT_FOUND']); break; }
        $pdo->prepare('UPDATE meeting_participants SET status=? WHERE meeting_id=? AND user_id=? AND status<>"removed"')
            ->execute(['removed', (int)$m['id'], $actorId]);
        echo json_encode(['ok' => true]);
        break;
    }

    // -----------------------------------------------------------
    // chat:persist — meeting chat message (idempotent via client_msg_id)
    // -----------------------------------------------------------
    case 'chat:persist': {
        $roomId = $in['room'] ?? ''; $userId = (int)($in['user_id'] ?? 0);
        $body = trim((string)($in['body'] ?? ''));
        $clientMsgId = substr((string)($in['client_msg_id'] ?? ''), 0, 64);
        if ($body === '' || $clientMsgId === '') { echo json_encode(['ok' => false, 'error' => 'BAD_REQUEST']); break; }
        $m = internal_meeting($pdo, $roomId);
        if (!$m) { echo json_encode(['ok' => false, 'error' => 'MEETING_NOT_FOUND']); break; }
        $p = internal_participant($pdo, $m['id'], $userId);
        if (!$p || $p['status'] === 'removed') { echo json_encode(['ok' => false, 'error' => 'NOT_A_MEMBER']); break; }
        $u = internal_user($pdo, $userId);
        // dedupe: existing row wins
        $q = $pdo->prepare('SELECT id FROM messages WHERE meeting_id=? AND user_id=? AND client_msg_id=?');
        $q->execute([(int)$m['id'], $userId, $clientMsgId]);
        $existing = $q->fetchColumn();
        if ($existing) {
            echo json_encode(['ok' => true, 'id' => (int)$existing, 'dedup' => true,
                'name' => $u ? $u['display_name'] : (string)$p['display_name']]);
            break;
        }
        try {
            $st = $pdo->prepare('INSERT INTO messages (meeting_id,user_id,display_name,body,client_msg_id) VALUES (?,?,?,?,?)');
            $st->execute([(int)$m['id'], $userId, $u ? $u['display_name'] : (string)$p['display_name'], $body, $clientMsgId]);
            echo json_encode(['ok' => true, 'id' => (int)$pdo->lastInsertId(),
                'name' => $u ? $u['display_name'] : (string)$p['display_name']]);
        } catch (PDOException $e) {
            // 23000 = unique violation → concurrent duplicate; treat as success
            if ($e->getCode() === '23000') {
                $q->execute([(int)$m['id'], $userId, $clientMsgId]);
                echo json_encode(['ok' => true, 'id' => (int)$q->fetchColumn(), 'dedup' => true,
                    'name' => $u ? $u['display_name'] : (string)$p['display_name']]);
            } else {
                echo json_encode(['ok' => false, 'error' => 'DB_ERROR']);
            }
        }
        break;
    }

    // -----------------------------------------------------------
    // pv:persist — private message manager<->user (idempotent)
    // -----------------------------------------------------------
    case 'pv:persist': {
        $toUserId = (int)($in['to_user_id'] ?? 0);
        $fromManager = !empty($in['from_manager']);
        $fromUserId = (int)($in['from_user_id'] ?? 0);
        $body = trim((string)($in['body'] ?? ''));
        $clientMsgId = substr((string)($in['client_msg_id'] ?? ''), 0, 64);
        if ($toUserId === 0 || $body === '' || $clientMsgId === '') { echo json_encode(['ok' => false, 'error' => 'BAD_REQUEST']); break; }
        // authorization: manager can message anyone; a user can only message the manager
        if (!$fromManager) {
            $u = internal_user($pdo, $fromUserId);
            if (!$u || empty($u['is_manager'])) { echo json_encode(['ok' => false, 'error' => 'NOT_AUTHORIZED']); break; }
        }
        $q = $pdo->prepare('SELECT id FROM pv_messages WHERE user_id=? AND from_manager=? AND client_msg_id=?');
        $q->execute([$toUserId, $fromManager ? 1 : 0, $clientMsgId]);
        $existing = $q->fetchColumn();
        if ($existing) { echo json_encode(['ok' => true, 'id' => (int)$existing, 'dedup' => true]); break; }
        try {
            $st = $pdo->prepare('INSERT INTO pv_messages (user_id, from_manager, body, client_msg_id) VALUES (?,?,?,?)');
            $st->execute([$toUserId, $fromManager ? 1 : 0, $body, $clientMsgId]);
            $id = (int)$pdo->lastInsertId();
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                $q->execute([$toUserId, $fromManager ? 1 : 0, $clientMsgId]);
                $id = (int)$q->fetchColumn();
            } else { echo json_encode(['ok' => false, 'error' => 'DB_ERROR']); break; }
        }
        $from = $fromManager ? internal_user($pdo, $fromUserId) : null;
        echo json_encode(['ok' => true, 'id' => $id,
            'from_name' => $from ? $from['display_name'] : 'کاربر',
            'ts' => date('Y-m-d H:i:s')]);
        break;
    }

    // -----------------------------------------------------------
    // pv:unread — unread count for conversation list updates
    // -----------------------------------------------------------
    case 'pv:unread': {
        $userId = (int)($in['user_id'] ?? 0);
        $s = $pdo->prepare('SELECT COUNT(*) FROM pv_messages WHERE user_id=? AND from_manager=0 AND seen=0');
        $s->execute([$userId]);
        echo json_encode(['ok' => true, 'unread' => (int)$s->fetchColumn()]);
        break;
    }

    // -----------------------------------------------------------
    // meeting:state — verify room + caller status (join pre-check)
    // -----------------------------------------------------------
    case 'meeting:state': {
        $roomId = $in['room'] ?? ''; $userId = (int)($in['user_id'] ?? 0);
        $m = internal_meeting($pdo, $roomId);
        if (!$m || !(int)$m['active']) { echo json_encode(['ok' => false, 'error' => 'MEETING_NOT_FOUND']); break; }
        $blocked = $pdo->prepare('SELECT 1 FROM meeting_blocks WHERE meeting_id=? AND user_id=?');
        $blocked->execute([(int)$m['id'], $userId]);
        if ($blocked->fetchColumn()) { echo json_encode(['ok' => false, 'error' => 'BLOCKED']); break; }
        $p = internal_participant($pdo, $m['id'], $userId);
        echo json_encode(['ok' => true, 'meeting' => [
            'id' => (int)$m['id'], 'room' => $m['room_id'], 'title' => $m['title']],
            'you' => $p ? ['status' => $p['status'], 'role' => $p['role']] : null]);
        break;
    }

    default:
        echo json_encode(['ok' => false, 'error' => 'UNKNOWN_ACTION']);
}
