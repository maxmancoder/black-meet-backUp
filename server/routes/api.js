'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const dbm = require('./../lib/db');
const {
  baseUrl, publicUrl, e, generateRoomId, makeSocketToken, isDevMode, avatarUrl, sqlNow,
} = require('./../lib/helpers');
const sessions = require('./../lib/sessions');
const pwd = require('./../lib/pwd');
const otp = require('./../lib/otp');
const internal = require('./../lib/internal');
const bus = require('./../lib/bus');
const { broadcastSecret } = require('./../lib/config');

const PHONE_RE = /^[0-9]{10,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function out(res, data, code) {
  return res.status(code || 200).json(data);
}
function ok(res, data) {
  return out(res, data);
}
function bad(res, data, code) {
  return out(res, data, code || 400);
}
function checkMethod(req, res, method) {
  if (req.method !== method) {
    bad(res, { ok: false, msg: 'متد نامعتبر' }, 405);
    return false;
  }
  return true;
}
function checkCsrf(req, res) {
  if (!sessions.csrfValid(req, req.body && req.body.csrf)) {
    bad(res, { ok: false, msg: 'درخواست نامعتبر' }, 403);
    return false;
  }
  return true;
}
function requireLoginApi(req, res) {
  if (sessions.currentUser(req) === null) {
    bad(res, { ok: false, msg: 'احراز هویت نشده' }, 401);
    return false;
  }
  return true;
}
function timingSafeEqStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const router = express.Router();

// ------------------------------------------------------------------
// auth / OTP
// ------------------------------------------------------------------

router.post('/signup.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;
  const full = String(req.body.full_name || '').trim();
  const user = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  const pass = String(req.body.password || '');

  if (full === '' || user === '' || email === '' || phone === '' || pass === '') {
    return bad(res, { ok: false, msg: 'تمام فیلدها الزامی هستند' });
  }
  if (!EMAIL_RE.test(email)) return bad(res, { ok: false, msg: 'ایمیل نامعتبر است' });
  if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره تلفن نامعتبر است' });
  if (pass.length < 6) return bad(res, { ok: false, msg: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });

  const dup = dbm.get('SELECT id FROM users WHERE username=? OR email=? OR phone=?', [user, email, phone]);
  if (dup) return bad(res, { ok: false, msg: 'اطلاعات وارد شده تکراری میباشد' });

  if (!otp.otpSendAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید' });
  }

  const hash = pwd.hashPassword(pass);
  const colors = ['#4f46e5', '#00a572', '#bf0f3c', '#c3c0ff', '#4edea3', '#ffb2b7'];
  const avatarColor = colors[crypto.randomInt(0, colors.length)];

  dbm.run(
    'INSERT INTO users (full_name, username, email, phone, password_hash, display_name, avatar_color, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [full, user, email, phone, hash, full, avatarColor, sqlNow()]
  );

  const code = otp.insertOtp(phone, 'signup');
  otp.devLogOtp(phone, code, 'signup');

  const response = { ok: true, phone, purpose: 'signup', msg: 'کد تأیید تولید شد' };
  if (isDevMode()) response.otp = code;
  return ok(res, response);
});

router.post('/login_phone.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;
  const phone = String(req.body.phone || '').trim();
  if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره تلفن نامعتبر است' });

  const u = dbm.get('SELECT id FROM users WHERE phone=?', [phone]);
  if (!u) return bad(res, { ok: false, msg: 'حساب وجود ندارد' });

  if (!otp.otpSendAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید' });
  }

  otp.otpCleanup(phone);
  const code = otp.insertOtp(phone, 'login_phone');
  otp.devLogOtp(phone, code, 'login_phone');

  const response = { ok: true, phone, purpose: 'login_phone' };
  if (isDevMode()) response.otp = code;
  return ok(res, response);
});

router.post('/resend_otp.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;
  const phone = String(req.body.phone || '').trim();
  const purpose = req.body.purpose === 'signup' ? 'signup' : 'login_phone';
  if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره نامعتبر است' });

  if (!otp.otpSendAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید' });
  }

  otp.otpCleanup(phone);
  const code = otp.insertOtp(phone, purpose);
  otp.devLogOtp(phone, code, 'resend_' + purpose);

  const response = { ok: true, msg: 'کد جدید ارسال شد' };
  if (isDevMode()) response.otp = code;
  return ok(res, response);
});

router.post('/verify_otp.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;

  const phone = String(req.body.phone || '').trim();
  const code = String(req.body.code || '').trim();
  const purpose = req.body.purpose === 'signup' ? 'signup' : 'login_phone';
  if (phone === '' || code === '') return bad(res, { ok: false, msg: 'داده ناقص' });

  if (!otp.otpVerifyAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تلاش‌های ناموفق زیاد است. لطفاً ۱۵ دقیقه صبر کنید' }, 429);
  }

  const row = dbm.get(
    'SELECT code, expires_at FROM verification_codes WHERE identifier=? AND purpose=? ORDER BY id DESC LIMIT 1',
    [phone, purpose]
  );
  if (!row) {
    otp.otpRecordFailure(phone);
    return bad(res, { ok: false, msg: 'کد تاییدی برای این شماره وجود ندارد. لطفاً ابتدا کد تایید را دریافت کنید.' });
  }
  const expires = Date.parse(row.expires_at.replace(' ', 'T'));
  if (isNaN(expires) || expires <= Date.now()) {
    otp.otpRecordFailure(phone);
    return bad(res, { ok: false, msg: 'کد تأیید منقضی شده است. لطفاً کد جدید دریافت کنید.' });
  }
  if (!timingSafeEqStr(row.code, code)) {
    otp.otpRecordFailure(phone);
    return bad(res, { ok: false, msg: 'کد تایید اشتباه است.' });
  }

  dbm.run('DELETE FROM verification_codes WHERE identifier=? AND purpose=?', [phone, purpose]);

  const user = dbm.get('SELECT id FROM users WHERE phone=?', [phone]);
  if (!user) return bad(res, { ok: false, msg: 'حساب یافت نشد' });

  sessions.establishLoginSession(req, res, user.id);
  return ok(res, { ok: true, redirect: baseUrl(req) + '/home.php' });
});

router.post('/login_email.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;

  const email = String(req.body.email || '').trim();
  const pass = String(req.body.password || '');

  const user = dbm.get('SELECT id, password_hash FROM users WHERE email=?', [email]);
  if (!user) return ok(res, { ok: false, msg: 'حساب وجود ندارد' });

  const r = pwd.verifyAndUpgradePassword(pass, user.password_hash);
  if (!r.ok) return ok(res, { ok: false, msg: 'حساب وجود ندارد' });

  if (r.upgradeHash !== null) {
    try { pwd.storeUpgradedPassword(user.id, r.upgradeHash); } catch (e) {}
  }

  sessions.establishLoginSession(req, res, user.id);
  return ok(res, { ok: true, redirect: baseUrl(req) + '/home.php' });
});

router.post('/logout.php', (req, res) => {
  sessions.invalidate(req, res);
  return ok(res, { ok: true, redirect: baseUrl(req) + '/index.php' });
});

router.get('/socket_token.php', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  const token = makeSocketToken(me.id, 0);
  return ok(res, { ok: true, token, user_id: Number(me.id) });
});

// ------------------------------------------------------------------
// meetings
// ------------------------------------------------------------------

router.post('/create_meeting.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  let title = String(req.body.title || '').trim();
  if (title === '') title = 'تماس بدون عنوان';
  const me = sessions.currentUser(req);

  if (me.is_limited) {
    return bad(res, { ok: false, msg: 'حساب شما محدود شده و اجازه ایجاد تماس ندارید' }, 403);
  }

  const roomId = generateRoomId();
  const r = dbm.run('INSERT INTO meetings (room_id, title, creator_id, active, created_at) VALUES (?,?,?,1,?)',
    [roomId, title, me.id, sqlNow()]);
  dbm.run(
    'INSERT INTO meeting_participants (meeting_id, user_id, display_name, username, status, role, joined_at) VALUES (?,?,?,?,?,?,?)',
    [r.lastInsertRowid, me.id, me.display_name, me.username, 'approved', 'admin', sqlNow()]
  );

  return ok(res, {
    ok: true,
    room_id: roomId,
    redirect: baseUrl(req) + '/call.php?room=' + roomId,
    share_url: publicUrl(req) + '/call.php?room=' + roomId,
  });
});

router.get('/meeting_info.php', (req, res) => {
  const room = String(req.query.room || '').trim();
  if (room === '') return bad(res, { ok: false, msg: 'لینک نامعتبر' }, 404);
  const row = dbm.get('SELECT room_id, title FROM meetings WHERE room_id=? AND active=1', [room]);
  if (!row) return bad(res, { ok: false, msg: 'تماسی با این لینک یافت نشد' }, 404);
  return ok(res, { ok: true, room_id: row.room_id, title: row.title });
});

router.post('/save_message.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  const body = String(req.body.body || '').trim();
  const mid = Number(req.body.meeting_id || 0);
  if (body === '' || mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const me = sessions.currentUser(req);
  const part = dbm.get(
    'SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=? AND status<>?',
    [mid, me.id, 'removed']
  );
  if (!part) return bad(res, { ok: false, msg: 'عضو نیستید' }, 403);

  dbm.run('INSERT INTO messages (meeting_id, user_id, display_name, body, created_at) VALUES (?,?,?,?,?)',
    [mid, me.id, me.display_name, body, sqlNow()]);
  return ok(res, { ok: true });
});

router.post('/save_emoji.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  const emoji = String(req.body.emoji || '');
  const mid = Number(req.body.meeting_id || 0);
  if (emoji === '' || mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const me = sessions.currentUser(req);
  const part = dbm.get(
    'SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=? AND status<>?',
    [mid, me.id, 'removed']
  );
  if (!part) return bad(res, { ok: false, msg: 'عضو نیستید' }, 403);

  dbm.run('INSERT INTO emoji_events (meeting_id, user_id, display_name, emoji, created_at) VALUES (?,?,?,?,?)',
    [mid, me.id, me.display_name, emoji, sqlNow()]);
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// member management (meeting admin; uses meetings.creator_id)
// ------------------------------------------------------------------

function memberActivity(req, res, action) {
  if (!checkMethod(req, res, 'POST')) return null;
  if (!requireLoginApi(req, res)) return null;
  if (!checkCsrf(req, res)) return null;

  const pid = Number(req.body.participant_id || 0);
  const me = sessions.currentUser(req);

  const part = dbm.get(
    'SELECT p.*, m.creator_id FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id WHERE p.id=?',
    [pid]
  );
  if (!part) { bad(res, { ok: false, msg: 'عضو یافت نشد' }); return null; }
  if (part.creator_id != me.id) { bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403); return null; }

  if (action === 'approved') {
    dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['approved', pid]);
  } else if (action === 'removed') {
    dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['removed', pid]);
  } else if (action === 'muted') {
    const muted = Number(req.body.muted != null ? req.body.muted : 1);
    dbm.run('UPDATE meeting_participants SET muted=? WHERE id=?', [muted ? 1 : 0, pid]);
    return ok(res, { ok: true, user_id: Number(part.user_id), muted: !!muted });
  }
  return ok(res, { ok: true });
}

router.post('/approve_member.php', (req, res) => {
  const r = memberActivity(req, res, 'approved');
  if (r === null) return;
  return r;
});
router.post('/reject_member.php', (req, res) => {
  const r = memberActivity(req, res, 'removed');
  if (r === null) return;
  return r;
});
router.post('/remove_member.php', (req, res) => {
  const part = resolveTarget(req, res);
  if (!part) return;
  dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['removed', part.id]);
  return ok(res, { ok: true, user_id: Number(part.user_id) });
});
router.post('/mute_member.php', (req, res) => {
  const part = resolveTarget(req, res);
  if (!part) return;
  const muted = Number(req.body.muted != null ? req.body.muted : 1);
  dbm.run('UPDATE meeting_participants SET muted=? WHERE id=?', [muted ? 1 : 0, part.id]);
  return ok(res, { ok: true, user_id: Number(part.user_id), muted: !!muted });
});

function resolveTarget(req, res) {
  if (!checkMethod(req, res, 'POST')) return null;
  if (!requireLoginApi(req, res)) return null;
  if (!checkCsrf(req, res)) return null;

  const pid = Number(req.body.participant_id || 0);
  const me = sessions.currentUser(req);

  const part = dbm.get(
    'SELECT p.*, m.creator_id FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id WHERE p.id=?',
    [pid]
  );
  if (!part) { bad(res, { ok: false, msg: 'عضو یافت نشد' }); return null; }
  if (part.creator_id != me.id) { bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403); return null; }
  return part;
}

router.post('/leave_meeting.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  const mid = Number(req.body.meeting_id || 0);
  if (mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const me = sessions.currentUser(req);
  const part = dbm.get(
    'SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=? AND status<>?',
    [mid, me.id, 'removed']
  );
  if (part) {
    dbm.run('UPDATE meeting_participants SET status=? WHERE meeting_id=? AND user_id=?', ['removed', mid, me.id]);
  }
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// profile
// ------------------------------------------------------------------

router.post('/profile_update.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  const me = sessions.currentUser(req);
  const display = String(req.body.display_name || '').trim();
  if (display === '') return bad(res, { ok: false, msg: 'نام نمایشی الزامی است' });

  dbm.run('UPDATE users SET display_name=? WHERE id=?', [display, me.id]);
  if (req.session) req.session.data.display_name = display;
  sessions.save(req);
  return ok(res, { ok: true, display_name: display });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

router.post('/upload_avatar.php', upload.single('avatar'), (req, res) => {
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  const me = sessions.currentUser(req);
  if (!req.file) return bad(res, { ok: false, msg: 'فایل انتخاب نشده' });

  const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const mime = req.file.mimetype;
  if (!allowed[mime]) return bad(res, { ok: false, msg: 'فرمت تصویر پشتیبانی نمی‌شود' });
  if (req.file.size > 2 * 1024 * 1024) return bad(res, { ok: false, msg: 'حجم تصویر بیش از ۲ مگابایت است' });

  const ext = allowed[mime];
  const rel = 'uploads/avatars/' + me.id + '.' + ext;
  const abs = path.join(dbm.rootDir, rel);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (e) { /* ignore */ }
  }
  for (const other of Object.values(allowed)) {
    const p = path.join(dbm.rootDir, 'uploads/avatars', me.id + '.' + other);
    if (p !== abs && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
    }
  }
  fs.writeFileSync(abs, req.file.buffer);

  dbm.run('UPDATE users SET avatar=? WHERE id=?', [rel, me.id]);
  return ok(res, { ok: true, avatar: avatarUrl(rel, req) });
});

// ------------------------------------------------------------------
// admin (manager only)
// ------------------------------------------------------------------

router.all('/admin_members.php', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  if (req.method === 'GET') {
    const users = dbm.all(
      'SELECT id, full_name, username, display_name, email, phone, is_manager, is_limited, avatar_color, created_at, password_hash FROM users ORDER BY id'
    );
    return ok(res, { ok: true, users });
  }

  if (req.method !== 'POST') return bad(res, { ok: false }, 405);
  if (!checkCsrf(req, res)) return;

  const action = String(req.body.action || '');
  const uid = Number(req.body.user_id || 0);
  if (uid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });
  if (uid === Number(me.id)) return bad(res, { ok: false, msg: 'نمی‌توانید حساب خود را مدیریت کنید' });

  const row = dbm.get('SELECT is_manager FROM users WHERE id=?', [uid]);
  if (!row) return bad(res, { ok: false, msg: 'کاربر یافت نشد' });
  if (row.is_manager) return bad(res, { ok: false, msg: 'مدیر را نمی‌توان محدود/تغییر داد' });

  if (action === 'reset_password') {
    let np = String(req.body.new_password || '').trim();
    if (np === '') {
      const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      np = '';
      for (let i = 0; i < 10; i++) np += chars[crypto.randomInt(0, chars.length)];
    }
    if (np.length < 6) return bad(res, { ok: false, msg: 'رمز عبور حداقل ۶ کاراکتر باشد' });
    dbm.run('UPDATE users SET password_hash=? WHERE id=?', [np, uid]);
    return ok(res, { ok: true, generated: (String(req.body.new_password || '').trim() === '') ? np : null });
  }

  dbm.run('UPDATE users SET is_limited = 1 - is_limited WHERE id=?', [uid]);
  const lim = dbm.get('SELECT is_limited FROM users WHERE id=?', [uid]);
  return ok(res, { ok: true, is_limited: !!lim.is_limited });
});

router.post('/admin_block.php', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  const me = sessions.currentUser(req);
  const mid = Number(req.body.meeting_id || 0);
  const uid = Number(req.body.user_id || 0);
  if (mid === 0 || uid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const role = dbm.get(
    'SELECT role FROM meeting_participants WHERE meeting_id=? AND user_id=?',
    [mid, me.id]
  );
  if ((!role || role.role !== 'admin') && !me.is_manager) {
    return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  }

  dbm.run('INSERT OR IGNORE INTO meeting_blocks (meeting_id, user_id) VALUES (?,?)', [mid, uid]);
  return ok(res, { ok: true });
});

router.all('/announcements.php', (req, res) => {
  if (!requireLoginApi(req, res)) return;

  if (req.method === 'GET') {
    const rows = dbm.all('SELECT id, body, created_at FROM announcements ORDER BY id DESC');
    return ok(res, { ok: true, announcements: rows });
  }

  if (req.method === 'POST') {
    const me = sessions.currentUser(req);
    if (!me.is_manager) return bad(res, { ok: false, msg: 'فقط مدیر' }, 403);
    if (!checkCsrf(req, res)) return;
    const body = String(req.body.body || '').trim();
    if (body === '') return bad(res, { ok: false, msg: 'متن خالی است' });

    const r = dbm.run('INSERT INTO announcements (body, created_at) VALUES (?,?)', [body, sqlNow()]);
    const notif = { id: r.lastInsertRowid, body, created_at: sqlNow() };
    bus.notifyNew(notif);
    return ok(res, { ok: true });
  }

  return bad(res, { ok: false, msg: 'متد نامعتبر' }, 405);
});

// ------------------------------------------------------------------
// private messages
// ------------------------------------------------------------------

function findUserByIdentifier(identifier) {
  identifier = String(identifier || '').trim();
  if (identifier === '') return null;
  if (EMAIL_RE.test(identifier)) {
    return dbm.get('SELECT id, username, display_name, avatar FROM users WHERE email=?', [identifier]);
  }
  return dbm.get('SELECT id, username, display_name, avatar FROM users WHERE phone=?', [identifier]);
}

router.all('/pv_user.php', (req, res) => {
  if (req.method === 'GET') {
    const identifier = String(req.query.identifier || '').trim();
    const u = findUserByIdentifier(identifier);
    if (!u) return ok(res, { ok: false, msg: 'کاربری با این مشخصات یافت نشد' });
    const messages = dbm.all(
      'SELECT id, from_manager, body, created_at FROM pv_messages WHERE user_id=? ORDER BY id ASC',
      [u.id]
    );
    return ok(res, { ok: true, user: u, messages });
  }

  if (req.method !== 'POST') return bad(res, { ok: false }, 405);
  const identifier = String(req.body.identifier || '').trim();
  const body = String(req.body.body || '').trim();
  if (body === '') return bad(res, { ok: false, msg: 'متن پیام خالی است' });

  const u = findUserByIdentifier(identifier);
  if (!u) return ok(res, { ok: false, msg: 'کاربری با این مشخصات یافت نشد' });

  dbm.run('INSERT INTO pv_messages (user_id, from_manager, body, created_at) VALUES (?,0,?,?)', [u.id, body, sqlNow()]);
  dbm.run('UPDATE users SET last_activity=? WHERE id=?', [sqlNow(), u.id]);
  bus.pvConversationUpdated({ userId: Number(u.id), lastBody: body, ts: sqlNow() });
  return ok(res, { ok: true });
});

router.all('/pv_manager.php', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  if (req.method === 'GET') {
    const uid = Number(req.query.user_id || 0);
    if (uid === 0) {
      const conversations = dbm.all(
        `SELECT DISTINCT m.user_id AS user_id, u.username, u.display_name, u.avatar, u.email, u.last_activity,
                (SELECT COUNT(*) FROM pv_messages p WHERE p.user_id=m.user_id AND p.from_manager=0 AND p.seen=0) AS unread
         FROM pv_messages m JOIN users u ON u.id=m.user_id ORDER BY m.user_id`
      );
      return ok(res, { ok: true, conversations });
    }
    const messages = dbm.all(
      'SELECT id, from_manager, body, created_at FROM pv_messages WHERE user_id=? ORDER BY id ASC',
      [uid]
    );
    dbm.run('UPDATE pv_messages SET seen=1 WHERE user_id=? AND from_manager=0', [uid]);
    return ok(res, { ok: true, messages });
  }

  if (!checkCsrf(req, res)) return;
  const uid = Number(req.body.user_id || 0);
  const body = String(req.body.body || '').trim();
  if (uid === 0 || body === '') return bad(res, { ok: false, msg: 'داده ناقص' });
  dbm.run('INSERT INTO pv_messages (user_id, from_manager, body, created_at) VALUES (?,1,?,?)', [uid, body, sqlNow()]);
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// compatibility endpoint: old signaling -> php-internal bridge (now in-process)
// ------------------------------------------------------------------

router.post('/internal.php', (req, res) => {
  return out(res, { ok: false, error: 'NOW_IN_PROCESS' }, 501);
});

module.exports = router;