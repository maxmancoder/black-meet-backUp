<?php
// api/socket_token.php — HMAC socket token for the *general* (non-call)
// realtime channel. Used by live.js at handshake; the meeting page keeps
// using make_socket_token(user_id, meeting_id) for room tokens.
require_once __DIR__ . '/../auth.php';
require_login_api();

$me = current_user();
$cfg = app_config();
$payload = 'u' . $me['id'] . '|0|' . time();
$sig = hash_hmac('sha256', $payload, $cfg['secret']);
json_out(['ok' => true, 'token' => $payload . '.' . $sig, 'user_id' => (int)$me['id']]);
