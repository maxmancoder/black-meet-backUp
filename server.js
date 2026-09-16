// server.js — Black Meet realtime server (Socket.IO) — Phase 1
// Handshake auth, presence, unified call room events (single business path
// via PHP api/internal.php), PV delivery, notifications, 1:1 call requests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const EV = require('./shared/socket-events');

const cfgPath = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const SECRET = cfg.secret;
const BASE = cfg.base_url || 'http://localhost/black-meet';
// NOTE: PORT=0 in env must be ignored (string "0" is truthy but listen(0) picks a random port)
const PORT = (parseInt(process.env.PORT, 10) || cfg.socket_port || 3000);
// Server-to-server secret (env var first, config fallback).
const BROADCAST_SECRET = process.env.BM_BROADCAST_SECRET || cfg.broadcast_secret || '';
const pendingClose = new Map(); // roomId -> timeout

// ------------------------------------------------------------------
// PHP internal API client (single business-logic path)
// ------------------------------------------------------------------
function phpInternal(action, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify(Object.assign({ action }, params));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', BROADCAST_SECRET).update(ts + '.' + body).digest('hex');
    const u = new URL(BASE + '/api/internal.php');
    const req = http.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BM-Timestamp': ts,
        'X-BM-Signature': sig,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, error: 'BAD_PHP_RESPONSE' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, error: 'PHP_UNREACHABLE' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'PHP_TIMEOUT' }); });
    req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------
// tokens
// ------------------------------------------------------------------
// meeting token: "uid|mid|ts" . hmac   |  user token: "u<uid>|0|ts" . hmac
function verifyToken(token, out = {}) {
  if (typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const f = payload.split('|');
  if (f.length !== 3) return false;
  if (Date.now() / 1000 - parseInt(f[2], 10) > 86400) return false;
  out.user_id = parseInt(String(f[0]).replace(/^u/, ''), 10);
  out.meeting_id = parseInt(f[1], 10);
  return out.user_id > 0;
}

// ------------------------------------------------------------------
// HTTP surface: /__broadcast (PHP → Node pushes)
// ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__broadcast') {
    if (!BROADCAST_SECRET) { res.writeHead(403); res.end('forbidden'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64e3) req.destroy(); });
    req.on('end', () => {
      const ts = String(req.headers['x-bm-timestamp'] || '');
      const sig = String(req.headers['x-bm-signature'] || '');
      const expected = crypto.createHmac('sha256', BROADCAST_SECRET).update(ts + '.' + body).digest('hex');
      const tsOk = ts && Math.abs(Date.now() / 1000 - parseInt(ts, 10)) < 300;
      if (!tsOk || !sig || sig.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.writeHead(401); res.end('unauthorized'); return;
      }
      try {
        const m = JSON.parse(body);
        if (m.event === EV.NOTIF_NEW) {
          // notification:new → every authenticated user socket
          io.of('/').sockets.forEach((s) => { if (s.data.userId) s.emit(EV.NOTIF_NEW, m.data || {}); });
        } else if (m.event === EV.PV_NEW_MESSAGE) {
          const d = m.data || {};
          const targets = userSockets.get(d.toUserId);
          if (targets) targets.forEach((sid) => io.to(sid).emit(EV.PV_NEW_MESSAGE, d));
        } else if (m.event === EV.PV_CONVERSATION_UPDATED) {
          const d = m.data || {};
          io.of('/').sockets.forEach((s) => {
            if (s.data.isManager && s.data.userId !== d.userId) s.emit(EV.PV_CONVERSATION_UPDATED, d);
          });
        } else if (m.room && m.event) {
          io.to('bm:' + m.room).emit(EV.BM_EVENT, { room: m.room, event: m.event, data: m.data || {} });
        }
      } catch (e) {}
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Black Meet signaling server is running.');
});

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,   // Socket.IO's own heartbeat doubles as presence watchdog
  pingTimeout: 20000,
});

// ------------------------------------------------------------------
// state
// ------------------------------------------------------------------
// roomId -> { meetingId, sockets:Map<socketId,member>, userSockets:Map<userId,Set<sid>>, pending:Set<uid>, blocked:Set<uid> }
const rooms = new Map();
// userId -> Set<socketId> (global, all pages)
const userSockets = new Map();

function addGlobalSocket(uid, sid) {
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(sid);
}
function removeGlobalSocket(uid, sid) {
  const set = userSockets.get(uid);
  if (!set) return;
  set.delete(sid);
  if (set.size === 0) userSockets.delete(uid);
}

function memberInfo(s) {
  return {
    userId: s.userId, name: s.name, username: s.username,
    avatar_color: s.avatar_color, avatar: s.avatar,
    is_admin: s.is_admin, muted: s.muted, cam: s.cam, sharing: s.sharing,
    approved: s.approved, status: s.approved ? 'approved' : 'pending',
  };
}

/** incremental member-list events (no full re-render on clients) */
function emitMemberJoined(roomId, member) { io.to(roomId).emit(EV.MEMBER_JOINED, { member }); }
function emitMemberLeft(roomId, userId) { io.to(roomId).emit(EV.MEMBER_LEFT, { userId }); }
function emitMemberUpdated(roomId, userId, patch) {
  io.to(roomId).emit(EV.MEMBER_UPDATED, Object.assign({ userId }, patch));
}
function memberList(roomId) {
  const r = rooms.get(roomId);
  if (!r) return [];
  const list = [];
  r.sockets.forEach((s) => list.push(memberInfo(s)));
  return list;
}

function scheduleCloseMeeting(roomId) {
  if (pendingClose.has(roomId)) return;
  const t = setTimeout(() => {
    pendingClose.delete(roomId);
    const body = new URLSearchParams({ secret: SECRET, room: roomId }).toString();
    const u = new URL(BASE + '/api/close_meeting.php');
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.write(body); req.end();
  }, 5000);
  pendingClose.set(roomId, t);
}

// ------------------------------------------------------------------
// 1:1 call requests — GLOBAL map (shared across all sockets)
// requestId -> { from, to, ts, roomId, status }
// ------------------------------------------------------------------
const callRequests = new Map();

// ------------------------------------------------------------------
// connection — AUTH IS MANDATORY AT HANDSHAKE
// ------------------------------------------------------------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const dec = {};
  if (!token || !verifyToken(token, dec) || !dec.user_id) {
    return next(new Error('UNAUTHORIZED'));
  }
  socket.data.userId = dec.user_id;
  socket.data.meetingId = dec.meeting_id || 0;
  // persist name on the socket as soon as the client tells us (auth:hello)
  next();
});

io.on('connection', (socket) => {
  const uid = socket.data.userId;
  addGlobalSocket(uid, socket.id);

  // ---- presence (first socket of this user → broadcast online) ----
  const firstConn = userSockets.get(uid) && userSockets.get(uid).size === 1;
  if (firstConn) io.emit(EV.PRESENCE_ONLINE, { userId: uid });
  socket.emit(EV.CONN_STATE, { state: 'connected', userId: uid });

  // heartbeat: client pings; server also relies on Socket.IO ping frames.
  socket.on(EV.PRESENCE_PING, () => { /* liveness = socket itself */ });

  // pages can query who is online right now
  socket.on('presence:list', (cb) => {
    if (typeof cb === 'function') cb({ ok: true, online: Array.from(userSockets.keys()) });
  });

  // client introduces itself (display name for rings, PV, etc.)
  socket.on(EV.AUTH_HELLO, (msg = {}) => {
    if (msg.name && typeof msg.name === 'string') socket.data.name = msg.name.slice(0, 120);
    if (msg.username && typeof msg.username === 'string') socket.data.username = msg.username.slice(0, 60);
  });

  // ----------------------------------------------------------------
  // announcements broadcast channel (home/messages pages)
  // ----------------------------------------------------------------
  socket.on(EV.BM_SUBSCRIBE, (msg = {}) => {
    const allowed = ['announcements'];
    const room = String(msg.room || '');
    if (allowed.includes(room)) socket.join('bm:' + room);
  });

  // ----------------------------------------------------------------
  // meeting room join — token must match this user; DB pre-check
  // ----------------------------------------------------------------
  socket.on(EV.CALL_JOIN, (payload = {}, cb) => {
    const { room, user } = payload;
    const token = payload.token || (socket.handshake.auth && socket.handshake.auth.token);
    const dec = {};
    if (!room || !verifyToken(token, dec) || dec.user_id !== uid || !user || (parseInt(user.id, 10) !== uid)) {
      const e = { ok: false, error: 'NOT_AUTHORIZED' };
      socket.emit(EV.ERR, e);
      if (typeof cb === 'function') cb(e);
      return;
    }
    phpInternal('meeting:state', { room, user_id: uid }).then((st) => {
      if (!st.ok) {
        const err = st.error === 'BLOCKED' ? 'BLOCKED' : 'MEETING_NOT_FOUND';
        const e = { ok: false, error: err };
        socket.emit(err === 'BLOCKED' ? EV.YOU_BLOCKED : EV.ERR, e);
        if (typeof cb === 'function') cb(e);
        return;
      }
      const meetingId = st.meeting.id;
      const role = st.you ? st.you.role : 'member';
      const approvedBefore = !!(st.you && st.you.status === 'approved');

      if (!rooms.has(room)) {
        rooms.set(room, { meetingId, sockets: new Map(), userSockets: new Map(), pending: new Set(), blocked: new Set() });
        if (pendingClose.has(room)) { clearTimeout(pendingClose.get(room)); pendingClose.delete(room); }
      }
      const r = rooms.get(room);
      // clean previous sockets of this user in the room (reconnect/tab dup)
      const prevSet = r.userSockets.get(uid);
      if (prevSet) {
        prevSet.forEach((sid) => {
          const prev = r.sockets.get(sid);
          if (prev && sid !== socket.id) {
            r.sockets.delete(sid);
            const target = io.of('/').sockets.get(sid);
            if (target) target.emit(EV.YOU_REMOVED, { ok: true, reason: 'replaced' });
          }
        });
      }

      const info = {
        userId: uid, name: String(user.name || ''), username: String(user.username || ''),
        avatar_color: String(user.avatar_color || '#4f46e5'), avatar: String(user.avatar || ''),
        is_admin: role === 'admin', muted: false, cam: false, sharing: false,
        approved: approvedBefore || role === 'admin',
      };
      socket.data.room = room;
      socket.data.is_admin = info.is_admin;
      socket.data.isManager = !!(user.is_manager);
      socket.join(room);
      r.sockets.set(socket.id, info);
      if (!r.userSockets.has(uid)) r.userSockets.set(uid, new Set());
      r.userSockets.get(uid).add(socket.id);

      // full bootstrap for the joiner (initial state via this one event)
      const you = memberInfo(info);
      const members = memberList(room).filter((m) => m.userId !== uid);
      socket.emit(EV.CALL_WELCOME, { meeting: st.meeting, you, members, blocked: Array.from(r.blocked) });

      if (info.approved) {
        socket.emit(EV.YOU_APPROVED, { ok: true });
        emitMemberJoined(room, you);
      } else {
        r.pending.add(uid);
        io.to(room).emit(EV.MEMBER_PENDING, { member: you });
      }
      if (typeof cb === 'function') cb({ ok: true, you, members });
    });
  });

  // ----------------------------------------------------------------
  // WebRTC signaling relay (room-scoped, validated)
  // ----------------------------------------------------------------
  socket.on(EV.CALL_SIGNAL, (msg = {}) => {
    const r = rooms.get(socket.data.room);
    if (!r || typeof msg.to !== 'number' || !msg.data) return;
    const targets = r.userSockets.get(msg.to);
    if (!targets) return;
    targets.forEach((sid) => io.to(sid).emit(EV.CALL_SIGNAL, { from: uid, data: msg.data }));
  });

  // ----------------------------------------------------------------
  // chat: persist via PHP (single path) → ack → broadcast
  // ----------------------------------------------------------------
  socket.on(EV.CALL_CHAT_SEND, (msg = {}, cb) => {
    const room = socket.data.room;
    const body = String(msg.body || '').trim().slice(0, 2000);
    const clientMsgId = String(msg.clientMsgId || '').slice(0, 64);
    if (!room || body === '' || clientMsgId === '') {
      const e = { ok: false, error: 'BAD_REQUEST' };
      if (typeof cb === 'function') cb(e);
      return;
    }
    const sInfo = rooms.get(room) && rooms.get(room).sockets.get(socket.id);
    if (!sInfo || !sInfo.approved) {
      const e = { ok: false, error: 'NOT_A_MEMBER' };
      socket.emit(EV.ERR, e);
      if (typeof cb === 'function') cb(e);
      return;
    }
    phpInternal('chat:persist', { room, user_id: uid, body, client_msg_id: clientMsgId }).then((res) => {
      if (!res.ok) {
        const e = { ok: false, error: res.error || 'SAVE_FAILED', clientMsgId };
        socket.emit(EV.CHAT_ACK, e);
        if (typeof cb === 'function') cb(e);
        return;
      }
      const payload = { id: res.id, userId: uid, name: res.name || sInfo.name, body, clientMsgId, ts: Date.now() };
      socket.emit(EV.CHAT_ACK, { ok: true, clientMsgId, id: res.id });
      io.to(room).emit(EV.CHAT_NEW_MESSAGE, payload);
      if (typeof cb === 'function') cb({ ok: true, id: res.id });
    });
  });

  socket.on(EV.CALL_EMOJI, (msg = {}) => {
    const room = socket.data.room;
    if (!room || typeof msg.emoji !== 'string' || msg.emoji.length > 8) return;
    socket.to(room).emit(EV.EMOJI, { userId: uid, name: (rooms.get(room).sockets.get(socket.id) || {}).name || '', emoji: msg.emoji });
  });

  socket.on(EV.CALL_STATUS, (st = {}) => {
    const room = socket.data.room;
    const r = rooms.get(room);
    if (!r) return;
    const s = r.sockets.get(socket.id);
    if (!s) return;
    const patch = {};
    if (typeof st.muted === 'boolean') { s.muted = st.muted; patch.muted = st.muted; }
    if (typeof st.cam === 'boolean') { s.cam = st.cam; patch.cam = st.cam; }
    if (typeof st.sharing === 'boolean') { s.sharing = st.sharing; patch.sharing = st.sharing; }
    emitMemberUpdated(room, uid, patch);
  });

  // ----------------------------------------------------------------
  // member actions — ONE path: socket → PHP (auth+DB) → broadcast
  // ----------------------------------------------------------------
  function requireRoomAdmin(room, uidArg) {
    const r = rooms.get(room);
    if (!r) return null;
    const me = r.sockets.get(socket.id);
    if (!me || !me.is_admin) return null;
    return r;
  }

  socket.on(EV.CALL_APPROVE, (msg = {}, cb) => {
    const room = socket.data.room;
    const targetId = parseInt(msg.userId, 10);
    if (!room || !Number.isInteger(targetId)) return;
    const r = requireRoomAdmin(room, uid);
    if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
    phpInternal('call:approve', { room, actor_id: uid, target_id: targetId }).then((res) => {
      if (!res.ok) { socket.emit(EV.ERR, { ok: false, error: res.error || 'ACTION_FAILED' }); if (typeof cb === 'function') cb({ ok: false, error: res.error }); return; }
      r.pending.delete(targetId);
      (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
        const s = r.sockets.get(sid);
        if (s) { s.approved = true; io.to(sid).emit(EV.YOU_APPROVED, { ok: true }); }
      });
      io.to(room).emit(EV.MEMBER_APPROVED, { member: res.member });
      if (typeof cb === 'function') cb({ ok: true, member: res.member });
    });
  });

  function kickFlow(evt, reasonEvt) {
    return (msg = {}, cb) => {
      const room = socket.data.room;
      const targetId = parseInt(msg.userId, 10);
      if (!room || !Number.isInteger(targetId)) return;
      const r = requireRoomAdmin(room, uid);
      if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
      phpInternal(evt, { room, actor_id: uid, target_id: targetId }).then((res) => {
        if (!res.ok) { socket.emit(EV.ERR, { ok: false, error: res.error || 'ACTION_FAILED' }); if (typeof cb === 'function') cb({ ok: false, error: res.error }); return; }
        r.pending.delete(targetId);
        (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
          const s = r.sockets.get(sid);
          if (s) s.approved = false;
          io.to(sid).emit(reasonEvt, { ok: true, reason: evt });
          const t = io.of('/').sockets.get(sid);
          if (t && t.data.room === room) { t.leave(room); t.data.room = null; }
        });
        r.userSockets.delete(targetId);
        io.to(room).emit(EV.MEMBER_KICKED, { userId: targetId, reason: evt });
        if (typeof cb === 'function') cb({ ok: true });
      });
    };
  }
  socket.on(EV.CALL_REJECT, kickFlow('call:reject', EV.YOU_REJECTED));
  socket.on(EV.CALL_KICK, kickFlow('call:kick', EV.YOU_REMOVED));

  socket.on(EV.CALL_BLOCK, (msg = {}, cb) => {
    const room = socket.data.room;
    const targetId = parseInt(msg.userId, 10);
    if (!room || !Number.isInteger(targetId)) return;
    const r = requireRoomAdmin(room, uid);
    if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
    phpInternal('call:block', { room, actor_id: uid, target_id: targetId }).then((res) => {
      if (!res.ok) { socket.emit(EV.ERR, { ok: false, error: res.error || 'ACTION_FAILED' }); if (typeof cb === 'function') cb({ ok: false, error: res.error }); return; }
      r.blocked.add(targetId);
      (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
        io.to(sid).emit(EV.YOU_BLOCKED, { ok: true });
        const t = io.of('/').sockets.get(sid);
        if (t && t.data.room === room) { t.leave(room); t.data.room = null; }
      });
      r.userSockets.delete(targetId);
      io.to(room).emit(EV.MEMBER_BLOCKED, { userId: targetId });
      if (typeof cb === 'function') cb({ ok: true });
    });
  });

  socket.on(EV.CALL_ALERT_ADMIN, () => {
    const room = socket.data.room;
    const r = rooms.get(room);
    if (!r) return;
    const me = r.sockets.get(socket.id);
    if (!me) return;
    r.sockets.forEach((s) => {
      if (s.is_admin) io.to(s.socketId).emit(EV.JOIN_ALERT, { userId: uid, name: me.name || '' });
    });
  });

  socket.on(EV.CALL_DISABLE, (msg = {}) => {
    const room = socket.data.room;
    const targetId = parseInt(msg.userId, 10);
    const kind = msg.kind;
    if (!room || !Number.isInteger(targetId) || !['audio', 'video', 'screen'].includes(kind)) return;
    const r = requireRoomAdmin(room, uid);
    if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); return; }
    const off = !!msg.off;
    (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
      const s = r.sockets.get(sid);
      if (!s) return;
      if (kind === 'audio') s.muted = off;
      else if (kind === 'video') s.cam = !off;
      else if (kind === 'screen') s.sharing = !off;
      io.to(sid).emit(EV.FORCE_DISABLE, { kind, off });
    });
    const patch = {};
    if (kind === 'audio') patch.muted = off;
    else if (kind === 'video') patch.cam = !off;
    else if (kind === 'screen') patch.sharing = !off;
    emitMemberUpdated(room, targetId, patch);
  });

  socket.on(EV.CALL_LEAVE, (_msg, cb) => {
    const room = socket.data.room;
    if (room) {
      phpInternal('call:leave', { room, actor_id: uid }).catch(() => {});
      leaveRoom(socket);
    }
    if (typeof cb === 'function') cb({ ok: true });
  });

  // ----------------------------------------------------------------
  // 1:1 call requests (ring between two users, any page) — shared state
  // ----------------------------------------------------------------
  function callReqTargets(uidArg) { return userSockets.get(uidArg) || new Set(); }

  socket.on(EV.CALLREQ_SEND, (msg = {}, cb) => {
    // accept both numeric and string ids (clients may send either)
    const toId = parseInt(msg.toUserId, 10);
    if (!Number.isInteger(toId) || toId === uid) { if (typeof cb === 'function') cb({ ok: false, error: 'BAD_REQUEST' }); return; }
    if (!callReqTargets(toId).size) { if (typeof cb === 'function') cb({ ok: false, error: 'USER_OFFLINE' }); return; }
    // busy check: any pending request involving either side
    for (const [, rq] of callRequests) {
      if (rq.status === 'ringing' && (rq.from === uid || rq.to === uid || rq.from === toId || rq.to === toId)) {
        if (typeof cb === 'function') cb({ ok: false, error: 'BUSY' }); return;
      }
    }
    const requestId = crypto.randomUUID();
    callRequests.set(requestId, { from: uid, to: toId, ts: Date.now(), roomId: msg.roomId || null, status: 'ringing' });
    const me = socket.data.name || ('user#' + uid);
    callReqTargets(toId).forEach((sid) => io.to(sid).emit(EV.CALLREQ_INCOMING, { requestId, fromUserId: uid, fromName: me }));
    if (typeof cb === 'function') cb({ ok: true, requestId });
    setTimeout(() => { const rq = callRequests.get(requestId); if (rq && rq.status === 'ringing') { rq.status = 'timeout'; callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_CANCELLED, { requestId, reason: 'timeout' })); } }, 45000);
  });

  socket.on(EV.CALLREQ_ACCEPT, (msg = {}, cb) => {
    const rq = callRequests.get(msg.requestId);
    if (!rq || rq.to !== uid || rq.status !== 'ringing') { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_FOUND' }); return; }
    rq.status = 'accepted';
    callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_ACCEPTED, { requestId: rq && msg.requestId, fromUserId: uid, roomId: rq.roomId }));
    if (typeof cb === 'function') cb({ ok: true, roomId: rq.roomId });
  });

  socket.on(EV.CALLREQ_REJECT, (msg = {}, cb) => {
    const rq = callRequests.get(msg.requestId);
    if (!rq || rq.to !== uid || rq.status !== 'ringing') { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_FOUND' }); return; }
    rq.status = 'rejected';
    callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_REJECTED, { requestId: msg.requestId, fromUserId: uid }));
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on(EV.CALLREQ_CANCEL, (msg = {}, cb) => {
    const rq = callRequests.get(msg.requestId);
    if (!rq || rq.from !== uid || rq.status !== 'ringing') { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_FOUND' }); return; }
    rq.status = 'cancelled';
    callReqTargets(rq.to).forEach((sid) => io.to(sid).emit(EV.CALLREQ_CANCELLED, { requestId: msg.requestId, reason: 'caller' }));
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on(EV.CALLREQ_BUSY, (msg = {}) => {
    const rq = callRequests.get(msg.requestId);
    if (!rq || rq.to !== uid || rq.status !== 'ringing') return;
    rq.status = 'busy';
    callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_BUSY, { requestId: msg.requestId, fromUserId: uid }));
  });

  socket.on(EV.CALLREQ_ENDED, (msg = {}) => {
    const rq = callRequests.get(msg.requestId);
    if (!rq) return;
    rq.status = 'ended';
    const other = rq.from === uid ? rq.to : rq.from;
    callReqTargets(other).forEach((sid) => io.to(sid).emit(EV.CALLREQ_ENDED, { requestId: msg.requestId, byUserId: uid }));
  });

  // ----------------------------------------------------------------
  // private messages — direct path (PV page is logged-in user side)
  // ----------------------------------------------------------------
  socket.on(EV.PV_SEND, (msg = {}, cb) => {
    const toId = parseInt(msg.toUserId, 10);
    const body = String(msg.body || '').trim().slice(0, 2000);
    const clientMsgId = String(msg.clientMsgId || '').slice(0, 64);
    if (!Number.isInteger(toId) || body === '' || clientMsgId === '') { if (typeof cb === 'function') cb({ ok: false, error: 'BAD_REQUEST' }); return; }
    phpInternal('pv:persist', { to_user_id: toId, from_manager: false, from_user_id: uid, body, client_msg_id: clientMsgId }).then((res) => {
      if (!res.ok) { const e = { ok: false, error: res.error || 'SAVE_FAILED', clientMsgId }; socket.emit(EV.ERR, e); if (typeof cb === 'function') cb(e); return; }
      const payload = { id: res.id, fromUserId: uid, fromName: res.from_name || '', body, clientMsgId, ts: res.ts };
      socket.emit(EV.PV_ACK, { ok: true, clientMsgId, id: res.id });
      // echo to all my sockets + deliver to target sockets
      (userSockets.get(uid) || new Set()).forEach((sid) => io.to(sid).emit(EV.PV_NEW_MESSAGE, payload));
      callReqTargets(toId).forEach((sid) => io.to(sid).emit(EV.PV_NEW_MESSAGE, payload));
      // conversation list updates for manager sockets
      io.of('/').sockets.forEach((s) => {
        if (s.data.isManager && s.data.userId !== uid) {
          s.emit(EV.PV_CONVERSATION_UPDATED, { userId: toId, lastBody: body, ts: res.ts });
        }
      });
      if (typeof cb === 'function') cb({ ok: true, id: res.id });
    });
  });

  // ----------------------------------------------------------------
  // leave / disconnect — single cleanup path
  // ----------------------------------------------------------------
  function leaveRoom(sock) {
    const room = sock.data.room;
    if (!room) return;
    const r = rooms.get(room);
    sock.data.room = null;
    sock.leave(room);
    if (!r) return;
    const s = r.sockets.get(sock.id);
    r.sockets.delete(sock.id);
    const set = r.userSockets.get(sock.data.userId);
    if (set) {
      set.delete(sock.id);
      if (set.size === 0) {
        r.userSockets.delete(sock.data.userId);
        r.pending.delete(sock.data.userId);
        emitMemberLeft(room, sock.data.userId);
      }
    }
    if (r.sockets.size === 0) {
      rooms.delete(room);
      scheduleCloseMeeting(room);
    }
  }

  socket.on('disconnect', () => {
    leaveRoom(socket);
    removeGlobalSocket(uid, socket.id);
    const gone = !userSockets.has(uid);
    if (gone) io.emit(EV.PRESENCE_OFFLINE, { userId: uid });
  });
});

server.listen(PORT, () => {
  console.log('Black Meet realtime server (Phase 1) listening on http://localhost:' + PORT);
});
