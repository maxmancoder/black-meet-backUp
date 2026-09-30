'use strict';
const express = require('express');
const dbm = require('./../lib/db');
const {
  baseUrl, publicUrl, assetUrl, avatarUrl, e, initials, timeAgo, turnConfig, makeSocketToken,
} = require('./../lib/helpers');
const sessions = require('./../lib/sessions');

function pageLocals(req, res, extra) {
  const base = baseUrl(req);
  const locals = {
    title: 'Black Meet',
    base,
    public: publicUrl(req),
    me: sessions.currentUser(req),
    csrf: sessions.csrfToken(req, res),
    asset(p) { return assetUrl(p, req); },
    url(p) { return base + '/' + p.replace(/^\/+/, ''); },
    esc: e,
    json(v) { return JSON.stringify(v); },
    initials,
    timeAgo,
    avatarUrl(a) { return avatarUrl(a, req); },
  };
  if (extra) Object.assign(locals, extra);
  return locals;
}

function requireLogin(req, res) {
  return sessions.requireLogin(req, res, baseUrl(req));
}

function requireManager(req, res) {
  if (!requireLogin(req, res)) return false;
  const me = sessions.currentUser(req);
  if (!me.is_manager) {
    res.redirect(baseUrl(req) + '/home');
    return false;
  }
  return true;
}

// old .php names -> clean Node routes (308 keeps method + query string)
function aliasPhp(oldPath, newPath) {
  router.get(oldPath, (req, res) => {
    const qi = req.url.indexOf('?');
    const q = qi >= 0 ? req.url.slice(qi) : '';
    res.redirect(308, baseUrl(req) + newPath + q);
  });
}

const router = express.Router();

router.get(['/', '/login'], (req, res) => {
  if (sessions.currentUser(req) !== null) {
    return res.redirect(baseUrl(req) + '/home');
  }
  res.render('index', pageLocals(req, res, { title: 'ورود / ثبت‌نام - Black Meet' }));
});

router.get('/home', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  const limited = !!me.is_limited;

  const recent = dbm.all(
    `SELECT m.id, m.room_id, m.title, m.created_at, m.active,
            (SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_id=m.id AND p.status<>'removed') AS members
     FROM meetings m WHERE m.creator_id=? ORDER BY m.created_at DESC LIMIT 6`,
    [me.id]
  );

  res.render('home', pageLocals(req, res, {
    title: 'خانه - Black Meet',
    me,
    limited,
    recent,
    isManager: !!me.is_manager,
    firstName: String(me.display_name || '').split(/\s+/)[0] || '',
    initials: initials(me.display_name),
  }));
});

router.get('/create', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  res.render('create', pageLocals(req, res, {
    title: 'ایجاد تماس - Black Meet',
    limited: !!me.is_limited,
  }));
});

router.get('/profile', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  res.render('profile', pageLocals(req, res, {
    title: 'پروفایل - Black Meet',
    av: avatarUrl(me.avatar, req),
    initials: initials(me.display_name),
  }));
});

router.get('/forgot-password', (req, res) => {
  res.render('forgot_password', pageLocals(req, res, { title: 'بازیابی رمز عبور - Black Meet' }));
});

router.get('/messages', (req, res) => {
  if (!requireManager(req, res)) return;
  res.render('messages', pageLocals(req, res, { title: 'پیام‌ها - Black Meet' }));
});

router.get('/members', (req, res) => {
  if (!requireManager(req, res)) return;
  const me = sessions.currentUser(req);
  const users = dbm.all(
    'SELECT id, full_name, username, display_name, email, phone, is_manager, is_limited, avatar_color, avatar, created_at, password_hash FROM users ORDER BY id'
  );
  res.render('admin_members', pageLocals(req, res, {
    title: 'مدیریت اعضا - Black Meet',
    me,
    users,
  }));
});

router.get('/meeting', (req, res) => {
  if (!requireLogin(req, res)) return;
  const room = String(req.query.room || '').trim();
  if (room === '') return res.redirect(baseUrl(req) + '/home');

  const meeting = dbm.get('SELECT * FROM meetings WHERE room_id=? AND active=1', [room]);
  if (!meeting) return res.redirect(baseUrl(req) + '/home?err=nomeeting');

  const me = sessions.currentUser(req);

  const blocked = dbm.get('SELECT 1 AS b FROM meeting_blocks WHERE meeting_id=? AND user_id=?', [meeting.id, me.id]);
  if (blocked) return res.redirect(baseUrl(req) + '/home?err=blocked');

  let part = dbm.get('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?', [meeting.id, me.id]);
  if (!part) {
    const r = dbm.run(
      'INSERT INTO meeting_participants (meeting_id, user_id, display_name, username, status, role, joined_at) VALUES (?,?,?,?,?,?,?)',
      [meeting.id, me.id, me.display_name, me.username, 'pending', 'member', now64()]
    );
    part = { id: r.lastInsertRowid, status: 'pending', role: 'member' };
  } else if (part.status === 'removed') {
    dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['pending', part.id]);
    part = { ...part, status: 'pending' };
  }
  const isAdmin = part.role === 'admin';
  const myStatus = part.status;

  const participants = dbm.all(
    `SELECT p.id, p.user_id, p.display_name, p.username, p.status, p.role, p.muted, p.cam_on, p.sharing,
            u.avatar_color, u.avatar, u.full_name, u.email, u.phone, u.is_manager
     FROM meeting_participants p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id=? AND p.status<>? ORDER BY p.id`,
    [meeting.id, 'removed']
  );

  const messages = dbm.all(
    'SELECT user_id, display_name, body, created_at FROM messages WHERE meeting_id=? ORDER BY id DESC LIMIT 50',
    [meeting.id]
  ).reverse();

  const emojis = dbm.all(
    'SELECT user_id, display_name, emoji FROM emoji_events WHERE meeting_id=? ORDER BY id DESC LIMIT 12',
    [meeting.id]
  );

  const init = {
    meeting: { id: Number(meeting.id), room: meeting.room_id, title: meeting.title, default_media: Number(meeting.default_media) !== 0 },
    me: {
      id: Number(me.id), name: me.display_name, username: me.username,
      avatar_color: me.avatar_color, avatar: String(me.avatar || ''), is_admin: isAdmin, status: myStatus,
    },
    token: makeSocketToken(me.id, meeting.id),
    socketUrl: '',
    iceServers: turnConfig(),
    base: baseUrl(req),
    participants,
    messages,
    emojis,
    csrf: sessions.csrfToken(req, res),
    publicUrl: publicUrl(req) + '/meeting?room=' + meeting.room_id,
  };

  res.render('call', pageLocals(req, res, {
    title: 'تماس - Black Meet',
    meeting,
    isAdmin,
    init,
    me,
    participants,
    initials: initials(me.display_name),
    isManager: !!me.is_manager,
  }));
});

function now64() {
  return require('./../lib/helpers').sqlNow();
}

// compatibility: old .php URLs redirect to their clean Node equivalents
aliasPhp('/index.php', '/login');
aliasPhp('/home.php', '/home');
aliasPhp('/create.php', '/create');
aliasPhp('/profile.php', '/profile');
aliasPhp('/forgot_password.php', '/forgot-password');
aliasPhp('/messages.php', '/messages');
aliasPhp('/admin_members.php', '/members');
aliasPhp('/call.php', '/meeting');

module.exports = router;