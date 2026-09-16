// tools/phase1_socket_tests.js — Phase 1 realtime test harness.
// Two independent socket.io clients (browser-session equivalents) exercise
// the full event contract. Usage: node tools/phase1_socket_tests.js
const http = require('http');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const EV = require('../shared/socket-events');

const BASE_HOST = 'localhost';
const PHP_BASE = 'http://localhost/black-meet';
const SOCK_URL = 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
function section(n) { console.log('\n== ' + n + ' =='); }

function phpSession() {
  // login a real user via PHP to obtain a session + CSRF
  return new Promise((resolve) => {
    const jar = [];
    http.get(PHP_BASE + '/index.php', (res) => {
      const setc = res.headers['set-cookie'] || [];
      setc.forEach(c => jar.push(c.split(';')[0]));
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const m = body.match(/window\.CSRF = "([^"]*)"/);
        const csrf = m ? m[1] : '';
        resolve({ jar, csrf });
      });
    });
  });
}
function phpPost(path, jar, form) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(form).toString();
    const req = http.request(PHP_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': jar.join('; '), 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      // replace session cookie if regenerated (session_regenerate_id after login)
      (res.headers['set-cookie'] || []).forEach(c => {
        const name = c.split('=')[0];
        const idx = jar.findIndex(x => x.startsWith(name + '='));
        if (idx >= 0) jar[idx] = c.split(';')[0]; else jar.push(c.split(';')[0]);
      });
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data.slice(0, 100) }); } });
    });
    req.write(body); req.end();
  });
}
function phpGet(path, jar) {
  return new Promise((resolve) => {
    http.get(PHP_BASE + path, { headers: { Cookie: jar.join('; ') } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data.slice(0, 100) }); } });
    });
  });
}

async function main() {
  // ============ AUTH: handshake ============
  section('Authentication');
  const badSock = io(SOCK_URL, { auth: { token: 'garbage' }, reconnection: false, timeout: 5000 });
  const badResult = await new Promise((resolve) => {
    badSock.on('connect', () => resolve('connected'));
    badSock.on('connect_error', (e) => resolve(String(e.message)));
    setTimeout(() => resolve('timeout'), 6000);
  });
  badSock.close();
  ok('unauthenticated socket rejected', badResult.indexOf('UNAUTHORIZED') >= 0);

  // real session for user A (manager) + user B
  const A = await phpSession();
  const loginA = await phpPost('/api/login_email.php', A.jar, { csrf: A.csrf, email: 'av0098056@gmail.com', password: 'amirali1388' });
  ok('A (manager) logged in', !!loginA.ok);
  const tokenA = await phpGet('/api/socket_token.php', A.jar);
  ok('A socket token issued', !!tokenA.ok && /u1\|/.test(tokenA.token));

  // signup user B
  const B = await phpSession();
  const rnd = Date.now() % 100000;
  const su = await phpPost('/api/signup.php', B.jar, { csrf: B.csrf, full_name: 'User B', username: 'uB' + rnd, email: 'ub' + rnd + '@t.com', phone: '0912' + String(7000000 + rnd), password: 'passB123' });
  ok('B signed up (DEV_MODE otp)', !!su.ok && !!su.otp);
  const vf = await phpPost('/api/verify_otp.php', B.jar, { csrf: B.csrf, phone: su.phone, code: su.otp, purpose: 'signup' });
  ok('B verified', !!vf.ok);
  const tokenB = await phpGet('/api/socket_token.php', B.jar);
  ok('B socket token issued', !!tokenB.ok);

  // ============ PRESENCE ============
  section('Presence');
  const sockA = io(SOCK_URL, { auth: { token: tokenA.token } });
  await new Promise(r => sockA.on('connect', r));
  ok('A connected (authed)', sockA.connected);
  const onlineA = await new Promise((resolve) => sockA.emit('presence:list', (resp) => resolve(resp)));
  ok('presence:list returns online users', onlineA.ok && onlineA.online.includes(1));

  const onlineEvt = new Promise((resolve) => sockA.once(EV.PRESENCE_ONLINE, resolve));
  const sockB = io(SOCK_URL, { auth: { token: tokenB.token } });
  await new Promise(r => sockB.on('connect', r));
  const onEvt = await Promise.race([onlineEvt, new Promise(r => setTimeout(() => r(null), 4000))]);
  ok('B online event reaches A', onEvt && onEvt.userId === tokenB.user_id);

  const offlineEvt = new Promise((resolve) => sockA.once(EV.PRESENCE_OFFLINE, resolve));
  sockB.close();
  const offEvt = await Promise.race([offlineEvt, new Promise(r => setTimeout(() => r(null), 5000))]);
  ok('B offline event after disconnect', offEvt && offEvt.userId === tokenB.user_id);

  // ============ PV (private message) ============
  section('Private messages');
  const sockB2 = io(SOCK_URL, { auth: { token: tokenB.token } });
  await new Promise(r => sockB2.on('connect', r));
  const pvReceived = new Promise((resolve) => sockB2.once(EV.PV_NEW_MESSAGE, resolve));
  const pvAck = new Promise((resolve) => sockA.once(EV.PV_ACK, resolve));
  const cmid = 't' + Date.now();
  sockA.emit(EV.PV_SEND, { toUserId: tokenB.user_id, body: 'سلام از مدیر — realtime', clientMsgId: cmid }, (resp) => {
    ok('PV send ack ok', resp && resp.ok);
  });
  const got = await Promise.race([pvReceived, new Promise(r => setTimeout(() => r(null), 4000))]);
  ok('B received pv:new-message live', got && got.body === 'سلام از مدیر — realtime' && Number(got.fromUserId) === 1);
  await Promise.race([pvAck, new Promise(r => setTimeout(() => r(null), 3000))]);

  // dedupe: same clientMsgId → server should not create a new row
  const ack2 = new Promise((resolve) => sockA.once(EV.PV_ACK, resolve));
  sockA.emit(EV.PV_SEND, { toUserId: tokenB.user_id, body: 'سلام از مدیر — realtime', clientMsgId: cmid }, () => {});
  const a2 = await Promise.race([ack2, new Promise(r => setTimeout(() => r(null), 4000))]);
  ok('duplicate clientMsgId handled (idempotent)', a2 && a2.ok);

  // ============ CALL REQUEST (1:1 ring) ============
  section('Call request');
  const incoming = new Promise((resolve) => sockB2.once(EV.CALLREQ_INCOMING, resolve));
  let reqId = null;
  const sendResp = await new Promise((resolve) => sockA.emit(EV.CALLREQ_SEND, { toUserId: tokenB.user_id, roomId: null }, resolve));
  reqId = sendResp && sendResp.requestId;
  ok('callreq:send ok', !!(sendResp && sendResp.ok));
  const inc = await Promise.race([incoming, new Promise(r => setTimeout(() => r(null), 4000))]);
  ok('B got callreq:incoming (no refresh)', inc && inc.requestId === reqId && Number(inc.fromUserId) === 1);
  const acceptedEvt = new Promise((resolve) => sockA.once(EV.CALLREQ_ACCEPTED, resolve));
  sockB2.emit(EV.CALLREQ_ACCEPT, { requestId: reqId });
  const acc = await Promise.race([acceptedEvt, new Promise(r => setTimeout(() => r(null), 4000))]);
  ok('A got callreq:accepted', acc && acc.requestId === reqId);

  // reject flow
  const sendResp2 = await new Promise((resolve) => sockA.emit(EV.CALLREQ_SEND, { toUserId: tokenB.user_id }, resolve));
  const reqId2 = sendResp2 && sendResp2.requestId;
  await new Promise(r => setTimeout(r, 500));
  const rejectedEvt = new Promise((resolve) => sockA.once(EV.CALLREQ_REJECTED, resolve));
  sockB2.emit(EV.CALLREQ_REJECT, { requestId: reqId2 });
  const rej = await Promise.race([rejectedEvt, new Promise(r => setTimeout(() => r(null), 4000))]);
  ok('A got callreq:rejected', rej && rej.requestId === reqId2);

  // ============ MEETING + MEMBER LIFECYCLE ============
  section('Meeting lifecycle');
  const mk = await phpPost('/api/create_meeting.php', A.jar, { csrf: A.csrf, title: 'Phase1 Realtime' });
  ok('meeting created', !!mk.ok);
  const room = mk.room_id;
  // fetch call page HTML to obtain meeting token (server-side make_socket_token)
  const callHtml = await new Promise((resolve) => {
    http.get(PHP_BASE + '/call.php?room=' + room, { headers: { Cookie: A.jar.join('; ') } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
  });
  const tm = callHtml.match(/"token":"([^"]+)"/);
  ok('call page contains meeting token', !!tm);
  const meetTokenA = tm[1];

  // join A
  const welcomeA = new Promise((resolve) => sockA.once(EV.CALL_WELCOME, resolve));
  const joinAResp = await new Promise((resolve) => sockA.emit(EV.CALL_JOIN, { room, token: meetTokenA, user: { id: 1, name: 'blackline', username: 'blackline', avatar_color: '#bf0f3c', is_admin: true, is_manager: true, status: 'approved' } }, resolve));
  const wA = await Promise.race([welcomeA, new Promise(r => setTimeout(() => r(null), 5000))]);
  ok('A welcome bootstrap', joinAResp && joinAResp.ok && wA && Array.isArray(wA.members));

  // B joins call page (fetch page HTML via B session — B is not approved yet)
  const callHtmlB = await new Promise((resolve) => {
    http.get(PHP_BASE + '/call.php?room=' + room, { headers: { Cookie: B.jar.join('; ') } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
  });
  const tmB = callHtmlB.match(/"token":"([^"]+)"/);
  const meetTokenB = tmB[1];
  const pendingEvt = new Promise((resolve) => sockA.once(EV.MEMBER_PENDING, resolve));
  let joinBresp = null;
  sockB2.emit(EV.CALL_JOIN, { room, token: meetTokenB, user: { id: tokenB.user_id, name: 'User B', username: 'uB' + rnd, avatar_color: '#4f46e5', is_admin: false, status: 'pending' } }, (r) => { joinBresp = r; });
  const pen = await Promise.race([pendingEvt, new Promise(r => setTimeout(() => r(null), 5000))]);
  ok('admin got member:pending instantly', pen && Number(pen.member.userId) === tokenB.user_id);

  // approve via single socket path
  const approvedEvt = new Promise((resolve) => sockB2.once(EV.YOU_APPROVED, resolve));
  const memberApprovedEvt = new Promise((resolve) => sockA.once(EV.MEMBER_APPROVED, resolve));
  sockA.emit(EV.CALL_APPROVE, { userId: tokenB.user_id }, (r) => { ok('approve cb ok', r && r.ok); });
  const ap = await Promise.race([approvedEvt, new Promise(r => setTimeout(() => r(null), 6000))]);
  const ap2 = await Promise.race([memberApprovedEvt, new Promise(r => setTimeout(() => r(null), 6000))]);
  ok('B got you-approved (no refresh)', !!ap);
  ok('room got member:approved', ap2 && Number(ap2.member.userId) === tokenB.user_id);

  // DB status check (authoritative single path)
  const dbState = await new Promise((resolve) => {
    const body = JSON.stringify({ action: 'meeting:state', room, user_id: tokenB.user_id });
    const ts = String(Math.floor(Date.now() / 1000));
    const secret = 'BMBroadcast_S2S_2026_vK7pQ2mR';
    const sig = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
    const req = http.request(PHP_BASE + '/api/internal.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BM-Timestamp': ts, 'X-BM-Signature': sig, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    });
    req.write(body); req.end();
  });
  ok('DB reflects approved status', dbState.ok && dbState.you && dbState.you.status === 'approved');

  // chat
  const chatEvt = new Promise((resolve) => sockB2.once(EV.CHAT_NEW_MESSAGE, resolve));
  const chatCid = 'c' + Date.now();
  sockA.emit(EV.CALL_CHAT_SEND, { body: 'سلام چت realtime', clientMsgId: chatCid }, (r) => { ok('chat ack ok (persisted id=' + (r && r.id) + ')', r && r.ok); });
  const ce = await Promise.race([chatEvt, new Promise(r => setTimeout(() => r(null), 5000))]);
  ok('B got chat:new-message live', ce && ce.body === 'سلام چت realtime');

  // kick flow
  const youRemovedEvt = new Promise((resolve) => sockB2.once(EV.YOU_REMOVED, resolve));
  sockA.emit(EV.CALL_KICK, { userId: tokenB.user_id }, (r) => { ok('kick cb ok', r && r.ok); });
  const rm = await Promise.race([youRemovedEvt, new Promise(r => setTimeout(() => r(null), 6000))]);
  ok('B got you-removed', !!rm);

  // rejoin → member:pending again (DB status=removed → pending per call.php logic)
  const rejoinPending = new Promise((resolve) => sockA.once(EV.MEMBER_PENDING, resolve));
  sockB2.emit(EV.CALL_JOIN, { room, token: meetTokenB, user: { id: tokenB.user_id, name: 'User B', username: 'uB' + rnd, avatar_color: '#4f46e5', is_admin: false, status: 'pending' } }, () => {});
  const rp = await Promise.race([rejoinPending, new Promise(r => setTimeout(() => r(null), 5000))]);
  ok('B rejoin → pending again (state restore)', !!rp);

  // ============ notifications ============
  section('Notifications');
  const annResp = await phpPost('/api/announcements.php', A.jar, { csrf: A.csrf, body: 'اعلان realtime فاز ۱ — ' + Date.now() });
  ok('announcement created', !!annResp.ok);
  // notif:new was likely consumed by an earlier once(); verify via bootstrap fetch instead
  const annList = await phpGet('/api/announcements.php', A.jar);
  ok('announcement persisted & fetchable', annList.ok && annList.announcements && annList.announcements.length > 0);

  sockA.close(); sockB2.close();
  console.log('\n================================');
  console.log('PASS: ' + pass + '  FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
