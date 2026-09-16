// assets/js/call.js — Phase 1: realtime call page
// - handshake-authenticated socket, single `call:join` path
// - perfect negotiation (polite/impolite) + ICE restart recovery
// - incremental member events (member:joined/left/updated/...)
// - admin actions via one socket path (server → PHP → DB → broadcast)
(function () {
  const I = window.INIT;
  const EV = window.BMEv;
  const ICE = (I && I.iceServers && I.iceServers.length) ? I.iceServers : [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const EMOJIS = ['👍', '❤️', '👏', '😂', '🎉', '😮', '🔥', '✅', '🙏', '💡', '😎', '🌟'];

  let socket = null;
  let localStream = null;
  let cameraTrack = null;
  let screenTrack = null;
  let currentVideoTrack = null;
  let micOn = false, camOn = false, sharing = false;
  let approved = (I.me.status === 'approved');

  const pcMap = new Map();        // userId -> { pc, polite, makingOffer, ignoreOffer, srdAnswerPending }
  const peerMeta = new Map();     // userId -> {name, avatar_color, avatar}
  const memberStatus = new Map(); // userId -> {muted,cam,sharing}
  const memberNames = new Map();  // userId -> display name
  const localBlock = {};          // userId -> {audio,video,screen} (per-viewer local blocks)
  const localAudio = {};          // userId -> {muted, volume}
  const remoteStreams = new Map();
  let menuUserId = null;
  let currentList = [];
  let joinedRoom = false;

  const $ = id => document.getElementById(id);
  const grid = $('video-grid');

  function showToast(msg) {
    const t = $('toast'); $('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }
  window.showToast = showToast;

  function playBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.value = 0.15;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 250);
    } catch (e) {}
  }

  window.alertAdmin = function () {
    if (socket) socket.emit(EV.CALL_ALERT_ADMIN);
    playBeep();
    showToast('درخواست ورود به ادمین ارسال شد');
  };

  window.adminBlock = function (userId) {
    if (socket) socket.emit(EV.CALL_BLOCK, { userId });
    showToast('کاربر از این تماس مسدود شد');
  };

  // ---------- Media ----------
  function startMedia() {
    if (!navigator.mediaDevices) { renderSelf(); return Promise.resolve(); }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .then(stream => {
        localStream = stream;
        cameraTrack = stream.getVideoTracks()[0] || null;
        micOn = true; camOn = true;
        currentVideoTrack = cameraTrack;
        updateSelfVideo();
        updateControlUI();
        pcMap.forEach(({ pc }) => addLocalTracks(pc));
      })
      .catch(() => { renderSelf(); updateControlUI(); });
  }

  function addLocalTracks(pc) {
    if (!localStream) return;
    localStream.getTracks().forEach(t => {
      const exists = pc.getSenders().some(s => s.track && s.track.kind === t.kind);
      if (!exists) pc.addTrack(t, localStream);
    });
  }

  function updateSelfVideo() {
    const v = $('self-video');
    const av = $('self-avatar');
    if (currentVideoTrack) {
      const s = new MediaStream([currentVideoTrack]);
      v.srcObject = s; v.style.display = ''; if (av) av.style.display = 'none';
    } else {
      v.srcObject = null; v.style.display = 'none'; if (av) av.style.display = '';
    }
  }

  function updateControlUI() {
    $('ic-mic').textContent = micOn ? 'mic' : 'mic_off';
    $('btn-mic').classList.toggle('ctrl-off', !micOn);
    $('ic-cam').textContent = camOn ? 'videocam' : 'videocam_off';
    $('btn-cam').classList.toggle('ctrl-off', !camOn);
    $('btn-share').classList.toggle('ctrl-off', !sharing);
  }

  // ---------- Tiles ----------
  function initials(name) {
    const p = (name || '').trim().split(/\s+/);
    if (p.length >= 2) return p[0][0] + p[1][0];
    return (name || '?').slice(0, 2);
  }

  function avatarUrl(a) {
    if (!a) return '';
    if (/^https?:\/\//i.test(a)) return a;
    return I.base + '/' + a.replace(/^\/+/, '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function avatarMarkup(meta) {
    meta = meta || {};
    const init = initials(meta.name || '؟');
    const color = /^#[0-9a-fA-F]{3,8}$/.test(meta.avatar_color || '') ? meta.avatar_color : '#4f46e5';
    if (meta.avatar) {
      return '<img src="' + escapeHtml(avatarUrl(meta.avatar)) + '" class="w-full h-full object-cover" alt=""/>';
    }
    return '<div class="w-full h-full flex items-center justify-center font-display-md text-white" style="background:' + color + '">' + escapeHtml(init) + '</div>';
  }

  function renderSelf() {
    if ($('tile-self')) return;
    const tile = document.createElement('div');
    tile.id = 'tile-self';
    tile.className = 'aspect-video bg-surface-container relative rounded-xl overflow-hidden shadow-lg border-2 border-secondary';
    tile.innerHTML = `
      <video id="self-video" autoplay muted playsinline class="w-full h-full object-cover"></video>
      <div id="self-avatar" class="hidden absolute inset-0 flex items-center justify-center">
        <div class="w-24 h-24 rounded-full flex items-center justify-center font-display-md text-white" style="background:${escapeHtml(I.me.avatar_color)}">${escapeHtml(initials(I.me.name))}</div>
      </div>
      <div class="absolute bottom-3 right-3 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
        <span class="font-label-md text-on-surface">${escapeHtml(I.me.name)} (شما)</span>
      </div>`;
    grid.appendChild(tile);
    updateSelfVideo();
  }

  function getOrCreateTile(userId, meta) {
    let tile = $('tile-' + userId);
    if (tile) return tile;
    tile = document.createElement('div');
    tile.id = 'tile-' + userId;
    tile.className = 'aspect-video bg-surface-container relative rounded-xl border border-white/10 overflow-hidden shadow-lg';
    tile.innerHTML = `
      <video id="vid-${userId}" autoplay playsinline class="w-full h-full object-cover"></video>
      <div id="av-${userId}" class="hidden absolute inset-0 flex items-center justify-center">
        ${avatarMarkup(meta)}
      </div>
      <div class="absolute top-3 right-3 bg-surface-container-highest/80 backdrop-blur-md px-2 py-1 rounded-md border border-white/10">
        <span id="mic-${userId}" class="material-symbols-outlined text-[14px] text-secondary">mic</span>
      </div>
      <div class="absolute bottom-3 right-3 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
        <span class="font-label-md text-on-surface" id="name-${userId}">${escapeHtml((meta && meta.name) || '')}</span>
      </div>`;
    tile.oncontextmenu = (e) => openMemberMenu(e, userId, meta && meta.name);
    grid.appendChild(tile);
    applyMediaOverrides(userId);
    updateTileName(userId);
    layoutGrid();
    return tile;
  }

  function removeTile(userId) {
    const t = $('tile-' + userId); if (t) t.remove();
    remoteStreams.delete(userId);
  }

  // ---------- WebRTC: perfect negotiation ----------
  function createPC(peer, initiator) {
    if (pcMap.has(peer.userId)) return pcMap.get(peer.userId);
    peerMeta.set(peer.userId, { name: peer.name, avatar_color: peer.avatar_color, avatar: peer.avatar || '' });
    getOrCreateTile(peer.userId, peer);

    // deterministic politeness: the peer with the larger userId is impolite
    const polite = I.me.id < peer.userId;
    const st = {
      pc: new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 4 }),
      polite,
      makingOffer: false,
      ignoreOffer: false,
      srdAnswerPending: false,
    };
    const pc = st.pc;
    pcMap.set(peer.userId, st);
    addLocalTracks(pc);

    pc.onicecandidate = e => {
      if (e.candidate && socket) socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'ice', candidate: e.candidate } });
    };
    pc.ontrack = e => {
      let rs = remoteStreams.get(peer.userId);
      if (!rs) { rs = new MediaStream(); remoteStreams.set(peer.userId, rs); }
      rs.addTrack(e.track);
      const v = $('vid-' + peer.userId);
      if (v) v.srcObject = rs;
      applyMediaOverrides(peer.userId);
    };
    pc.onnegotiationneeded = async () => {
      if (!socket) return;
      try {
        st.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'desc', sdp: pc.localDescription } });
      } catch (e) {
      } finally {
        st.makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        // ICE restart — no page refresh needed for routine recovery
        try { pc.restartIce(); } catch (e) {}
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (e) {}
      }
    };

    if (initiator && socket && socket.connected) {
      // explicit initial offer from the deterministic initiator
      try {
        st.makingOffer = true;
        pc.createOffer().then(async (offer) => {
          await pc.setLocalDescription(offer);
          socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'desc', sdp: pc.localDescription } });
        }).finally(() => { st.makingOffer = false; });
      } catch (e) { st.makingOffer = false; }
    }
    return st;
  }

  async function handleSignal(from, data) {
    if (from === I.me.id) return;
    let st = pcMap.get(from);
    if (!st) {
      const meta = peerMeta.get(from) || { name: memberNames.get(from) || '', avatar_color: '#4f46e5', avatar: '' };
      st = createPC({ userId: from, ...meta }, false);
      updateTileName(from);
    }
    const pc = st.pc;
    try {
      if (data.type === 'desc') {
        const offerCollision = data.sdp.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
        st.ignoreOffer = !st.polite && offerCollision;
        if (st.ignoreOffer) return;
        if (offerCollision) {
          const rollback = Promise.resolve(pc.setLocalDescription({ type: 'rollback' }));
          await rollback;
        }
        await pc.setRemoteDescription(data.sdp);
        st.srdAnswerPending = false;
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit(EV.CALL_SIGNAL, { to: from, data: { type: 'desc', sdp: pc.localDescription } });
        }
      } else if (data.type === 'ice') {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!st.ignoreOffer) throw err;
        }
      }
    } catch (e) { /* recoverable: ICE restart will kick in on failure states */ }
  }

  function destroyPC(userId) {
    const st = pcMap.get(userId);
    if (st) { try { st.pc.close(); } catch (e) {} pcMap.delete(userId); }
  }

  function replaceOutgoingVideo(track) {
    currentVideoTrack = track;
    pcMap.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(track).catch(() => {});
    });
    updateSelfVideo();
  }

  // ---------- Socket ----------
  function broadcastStatus() {
    if (socket) socket.emit(EV.CALL_STATUS, { muted: !micOn, cam: camOn, sharing });
  }

  function doJoin(cb) {
    if (!socket || !socket.connected || joinedRoom) { if (typeof cb === 'function') cb({ ok: false }); return; }
    joinedRoom = true;
    socket.emit(EV.CALL_JOIN, {
      room: I.meeting.room,
      token: I.token,
      user: {
        id: I.me.id, name: I.me.name, username: I.me.username,
        avatar_color: I.me.avatar_color, avatar: I.me.avatar || '',
        is_admin: I.me.is_admin, is_manager: !!window.__BM_isManager, status: I.me.status
      }
    }, (resp) => {
      if (resp && resp.ok) {
        // apply authoritative bootstrap members
        (resp.members || []).forEach(m => {
          memberNames.set(m.userId, m.name);
          peerMeta.set(m.userId, { name: m.name, avatar_color: m.avatar_color, avatar: m.avatar || '' });
          memberStatus.set(m.userId, { muted: !!m.muted, cam: m.cam !== false, sharing: !!m.sharing });
          if (m.status === 'approved') {
            getOrCreateTile(m.userId, m);
            createPC(m, I.me.id > m.userId);
          }
          renderOneMember(m);
        });
        currentList = (resp.members || []).slice();
        renderPendingCards();
      } else if (resp && resp.error === 'BLOCKED') {
        showToast('شما از این تماس مسدود شده‌اید');
        setTimeout(() => location.href = I.base + '/home.php?err=blocked', 1500);
      } else if (resp && resp.error === 'MEETING_NOT_FOUND') {
        showToast('این تماس دیگر فعال نیست');
        setTimeout(() => location.href = I.base + '/home.php', 1500);
      }
      if (typeof cb === 'function') cb(resp || { ok: false });
    });
  }

  function connectSocket() {
    // call page uses the meeting token directly at handshake
    socket = io(I.socketUrl || undefined, {
      auth: { token: I.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });
    window.BM_SOCKET = socket;

    socket.on('connect', () => {
      const el = $('conn-state'); if (el) { el.textContent = 'زنده'; el.className = 'w-2 h-2 rounded-full bg-secondary'; }
      joinedRoom = false;
      if (mediaReady) doJoin();
    });
    socket.on('disconnect', () => {
      const el = $('conn-state'); if (el) { el.textContent = 'قطع'; el.className = 'w-2 h-2 rounded-full bg-error'; }
    });
    socket.on('reconnect_attempt', () => {
      const el = $('conn-state'); if (el) { el.textContent = 'اتصال...'; el.className = 'w-2 h-2 rounded-full bg-warning'; }
    });
    socket.on(EV.ERR, d => showToast(d.msg || d.error || 'خطا'));

    socket.on(EV.YOU_APPROVED, () => {
      approved = true;
      $('waiting-overlay').classList.add('hidden');
      broadcastStatus();
    });
    socket.on(EV.CALL_WELCOME, (d) => {
      // authoritative initial room state
      (d.members || []).forEach(m => {
        memberNames.set(m.userId, m.name);
        peerMeta.set(m.userId, { name: m.name, avatar_color: m.avatar_color, avatar: m.avatar || '' });
        memberStatus.set(m.userId, { muted: !!m.muted, cam: m.cam !== false, sharing: !!m.sharing });
        if (m.status === 'approved') {
          getOrCreateTile(m.userId, m);
          createPC(m, I.me.id > m.userId);
        }
        renderOneMember(m);
      });
      currentList = (d.members || []).slice();
      renderPendingCards();
    });
    socket.on(EV.MEMBER_JOINED, ({ member }) => {
      memberNames.set(member.userId, member.name);
      peerMeta.set(member.userId, { name: member.name, avatar_color: member.avatar_color, avatar: member.avatar || '' });
      memberStatus.set(member.userId, { muted: !!member.muted, cam: member.cam !== false, sharing: !!member.sharing });
      currentList = currentList.filter(m => m.userId !== member.userId).concat([member]);
      renderOneMember(member);
      renderPendingCards();
    });
    socket.on(EV.MEMBER_LEFT, ({ userId }) => {
      currentList = currentList.filter(m => m.userId !== userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
      layoutGrid();
    });
    socket.on(EV.MEMBER_UPDATED, (d) => {
      const cur = memberStatus.get(d.userId) || {};
      if (d.muted !== undefined) cur.muted = d.muted;
      if (d.cam !== undefined) cur.cam = d.cam;
      if (d.sharing !== undefined) cur.sharing = d.sharing;
      memberStatus.set(d.userId, cur);
      const m = currentList.find(x => x.userId === d.userId);
      if (m) Object.assign(m, d);
      updateTileStatus(d.userId);
    });
    socket.on(EV.MEMBER_PENDING, ({ member }) => {
      memberNames.set(member.userId, member.name);
      peerMeta.set(member.userId, { name: member.name, avatar_color: member.avatar_color, avatar: member.avatar || '' });
      currentList = currentList.filter(m => m.userId !== member.userId).concat([member]);
      renderOneMember(member);
      renderPendingCards();
      playBeep();
      showToast('درخواست ورود از سمت ' + (member.name || 'یک کاربر'));
    });
    socket.on(EV.MEMBER_APPROVED, ({ member }) => {
      memberNames.set(member.userId, member.name);
      peerMeta.set(member.userId, { name: member.name, avatar_color: member.avatar_color, avatar: member.avatar || '' });
      currentList = currentList.filter(m => m.userId !== member.userId).concat([member]);
      memberStatus.set(member.userId, { muted: false, cam: false, sharing: false });
      if (member.userId !== I.me.id) {
        getOrCreateTile(member.userId, member);
        createPC(member, I.me.id > member.userId);
      }
      renderOneMember(member);
      renderPendingCards();
    });
    socket.on(EV.MEMBER_KICKED, ({ userId }) => {
      currentList = currentList.filter(m => m.userId !== userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
    });
    socket.on(EV.MEMBER_BLOCKED, ({ userId }) => {
      currentList = currentList.filter(m => m.userId !== userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
    });
    socket.on(EV.FORCE_DISABLE, d => {
      if (d.kind === 'audio') {
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !d.off);
        micOn = !d.off; updateControlUI(); broadcastStatus();
      } else if (d.kind === 'video') {
        if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = !d.off);
        camOn = !d.off;
        if (camOn && !sharing) currentVideoTrack = cameraTrack;
        else if (!camOn && !sharing) currentVideoTrack = null;
        updateSelfVideo(); updateControlUI(); broadcastStatus();
      } else if (d.kind === 'screen') {
        if (d.off) stopShare();
      }
    });
    socket.on(EV.YOU_REJECTED, () => { showToast('درخواست شما رد شد'); setTimeout(() => location.href = I.base + '/home.php', 1500); });
    socket.on(EV.YOU_REMOVED, () => { showToast('از تماس حذف شدید'); setTimeout(() => location.href = I.base + '/home.php', 1500); });
    socket.on(EV.YOU_BLOCKED, () => { showToast('شما مسدود شدید'); setTimeout(() => location.href = I.base + '/home.php?err=blocked', 2000); });
    socket.on(EV.JOIN_ALERT, d => {
      playBeep();
      showToast('درخواست ورود از سمت ' + (d.name || 'یک کاربر'));
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('درخواست ورود', { body: d.name || '' }); } catch (e) {}
    });

    // WebRTC signals (new contract) — legacy 'signal' also kept briefly for safety
    socket.on(EV.CALL_SIGNAL, ({ from, data }) => { handleSignal(from, data); });

    socket.on(EV.CHAT_NEW_MESSAGE, d => {
      memberNames.set(d.userId, d.name);
      appendMessage(d.userId, d.name, d.body, d.userId === I.me.id);
    });
    socket.on(EV.CHAT_ACK, d => {
      if (!d.ok) showToast('ارسال پیام ناموفق: ' + (d.error || ''));
    });
    socket.on(EV.EMOJI, d => spawnEmoji(d.emoji));
  }

  // ---------- Sidebar / members (incremental) ----------
  function memberRow(m) {
    const isSelf = m.userId === I.me.id;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 p-2 hover:bg-surface-container rounded-lg transition-colors group';
    row.dataset.uid = m.userId;
    const mutedIcon = m.muted ? '<span class="material-symbols-outlined text-[10px] text-on-error">mic_off</span>' : '<span class="material-symbols-outlined text-[10px] text-on-secondary">mic</span>';
    let actions = '';
    if (I.me.is_admin && !isSelf) {
      actions = `<div class="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
        <button class="p-1.5 text-on-surface-variant hover:text-error hover:bg-error/10 rounded-md" title="حذف" onclick="adminRemove(${m.userId})"><span class="material-symbols-outlined text-[18px]">person_remove</span></button>
      </div>`;
    }
    row.innerHTML = `
      <div class="relative">
        <div class="w-10 h-10 rounded-full overflow-hidden border border-outline-variant">${avatarMarkup(m)}</div>
        <span class="absolute -bottom-1 -right-1 w-4 h-4 ${m.status === 'approved' ? 'bg-secondary' : 'bg-error'} rounded-full border-2 border-surface-container-low flex items-center justify-center">${mutedIcon}</span>
      </div>
      <div class="flex-1 min-w-0">
        <h4 class="font-body-sm font-semibold text-on-surface truncate">${escapeHtml(m.name)}${isSelf ? ' (شما)' : ''}</h4>
        <p class="font-label-sm text-on-surface-variant text-[10px]">${m.status === 'approved' ? (m.is_admin ? 'مدیر تماس' : 'عضو') : 'در انتظار تایید'}</p>
      </div>${actions}`;
    row.oncontextmenu = (e) => openMemberMenu(e, m.userId, m.name);
    return row;
  }

  function upsertMemberRow(m) {
    const wrap = $('member-list');
    const existing = wrap.querySelector(`[data-uid="${m.userId}"]`);
    const newRow = memberRow(m);
    if (existing) existing.replaceWith(newRow);
    else wrap.appendChild(newRow);
  }
  function removeMemberRow(userId) {
    const wrap = $('member-list');
    const existing = wrap.querySelector(`[data-uid="${userId}"]`);
    if (existing) existing.remove();
  }
  /** insert in list order; keeps pending members at the bottom */
  function renderOneMember(m) {
    upsertMemberRow(m);
    updateCounts();
    updateTileName(m.userId);
    updateTileStatus(m.userId);
  }
  function updateCounts() {
    const list = currentList;
    $('participant-count').textContent = list.length;
    const pendingCount = list.filter(m => m.status !== 'approved' && m.userId !== I.me.id).length;
    const badge = $('admin-badge'); if (badge) badge.classList.toggle('hidden', pendingCount === 0);
    const sBadge = $('sidebar-badge'); if (sBadge) sBadge.classList.toggle('hidden', pendingCount === 0);
  }

  function renderPendingCards() {
    const req = $('join-requests');
    if (!req) return;
    req.innerHTML = '';
    let pendingCount = 0;
    currentList.forEach(m => {
      if (m.status !== 'approved' && I.me.is_admin && m.userId !== I.me.id) {
        pendingCount++;
        const card = document.createElement('div');
        card.className = 'bg-surface-container border border-outline-variant/30 rounded-xl p-3 flex flex-col gap-3';
        card.innerHTML = `
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full overflow-hidden border border-outline-variant">${avatarMarkup(m)}</div>
            <div><h4 class="font-body-sm font-semibold text-on-surface">${escapeHtml(m.name)}</h4><p class="font-label-sm text-on-surface-variant text-[10px]">@${escapeHtml(m.username)}</p></div>
          </div>
          <div class="flex gap-2">
            <button class="flex-1 bg-secondary-container hover:bg-secondary text-on-secondary-container font-label-md py-1.5 rounded-md transition-colors" onclick="adminApprove(${m.userId})">تایید</button>
            <button class="flex-1 border border-error/50 text-error hover:bg-error/10 font-label-md py-1.5 rounded-md transition-colors" onclick="adminReject(${m.userId})">رد</button>
          </div>`;
        req.appendChild(card);
      }
    });
    updateCounts();
    if (I.me.is_admin) renderAdminMembers(currentList);
  }

  function renderAdminMembers(list) {
    const wrap = $('admin-members');
    if (!wrap) return;
    wrap.innerHTML = '';
    list.forEach(m => {
      if (m.userId === I.me.id) return;
      const st = memberStatus.get(m.userId) || {};
      const card = document.createElement('div');
      card.className = 'bg-surface-container border border-outline-variant/30 rounded-xl p-3 mb-3';
      const ctrl = (kind, label) => {
        const selfOn = localBlock[m.userId] && localBlock[m.userId][kind];
        const allOff = kind === 'audio' ? st.muted
                     : kind === 'video' ? (st.cam === false)
                     : (st.sharing === false);
        return `<div class="flex flex-col items-center gap-1">
          <span class="font-label-sm text-on-surface-variant text-[11px]">${label}</span>
          <div class="flex gap-1">
            <button class="text-[11px] px-2 py-1 rounded-md ${selfOn ? 'bg-error-container text-on-error-container' : 'bg-surface-container-high text-on-surface'} hover:opacity-80" onclick="adminBlockSelf(${m.userId},'${kind}')">برای من</button>
            <button class="text-[11px] px-2 py-1 rounded-md ${allOff ? 'bg-error-container text-on-error-container' : 'bg-secondary-container text-on-secondary-container'} hover:opacity-80" onclick="adminDisableAll(${m.userId},'${kind}')">${allOff ? 'روشن همه' : 'قطع همه'}</button>
          </div>
        </div>`;
      };
      card.innerHTML = `
        <div class="flex items-center gap-2 mb-3">
          <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px]" style="background:${/^#[0-9a-fA-F]{3,8}$/.test(m.avatar_color || '') ? m.avatar_color : '#4f46e5'}">${escapeHtml(initials(m.name))}</div>
          <span class="font-body-sm text-on-surface truncate">${escapeHtml(m.name)}</span>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
          ${ctrl('audio', 'صدا')}
          ${ctrl('video', 'تصویر')}
          ${ctrl('screen', 'صفحه')}
        </div>
        <div class="flex gap-2 mt-3">
          <button class="flex-1 bg-error-container/80 hover:bg-error-container text-on-error-container font-label-md py-1.5 rounded-md transition-colors" onclick="adminRemove(${m.userId})">حذف عضو</button>
          <button class="flex-1 bg-surface-container-high hover:bg-surface-bright text-on-surface font-label-md py-1.5 rounded-md transition-colors" onclick="adminBlock(${m.userId})">مسدود کردن</button>
        </div>`;
      wrap.appendChild(card);
    });
    if (!list.some(m => m.userId !== I.me.id)) {
      wrap.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">عضو دیگری در تماس نیست.</p>';
    }
  }

  // ---------- Chat ----------
  function appendMessage(userId, name, body, self) {
    const box = $('chat-messages');
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col ' + (self ? 'items-end' : 'items-start') + ' gap-1';
    const meta = peerMeta.get(userId) || { name: name, avatar: '' };
    const av = self
      ? '<div class="w-7 h-7 rounded-full overflow-hidden border border-outline-variant">' + avatarMarkup({ name: I.me.name, avatar: I.me.avatar, avatar_color: I.me.avatar_color }) + '</div>'
      : '<div class="w-7 h-7 rounded-full overflow-hidden border border-outline-variant">' + avatarMarkup(meta) + '</div>';
    wrap.innerHTML = `
      <div class="flex items-center gap-2 mb-1">
        ${av}
        <span class="font-label-sm text-on-surface-variant">${escapeHtml(self ? 'شما' : (name || 'بدون نام'))}</span>
      </div>
      <div class="${self ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface'} p-3 rounded-2xl ${self ? 'rounded-tl-sm' : 'rounded-tr-sm'} text-body-sm max-w-[85%] border border-white/5">${escapeHtml(body)}</div>`;
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  window.sendChat = function () {
    const inp = $('chat-input');
    const body = inp.value.trim();
    if (!body) return;
    const clientMsgId = 'm' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    inp.value = '';
    // optimistic UI: message appears now; server ack + broadcast are idempotent
    appendMessage(I.me.id, I.me.name, body, true);
    if (socket && socket.connected) {
      socket.emit(EV.CALL_CHAT_SEND, { body, clientMsgId }, resp => {
        if (!resp || !resp.ok) showToast('ارسال پیام ناموفق: ' + ((resp && resp.error) || ''));
      });
    } else {
      showToast('اتصال زنده قطع است');
    }
  };

  // ---------- Emoji ----------
  function buildEmojiGrid() {
    const g = $('emoji-grid');
    EMOJIS.forEach(em => {
      const b = document.createElement('button');
      b.className = 'text-2xl hover:scale-110 transition-transform p-1';
      b.textContent = em;
      b.onclick = () => { spawnEmoji(em, true); toggleEmojiPicker(true); };
      g.appendChild(b);
    });
  }
  function spawnEmoji(em, broadcast) {
    const canvas = $('emoji-canvas');
    const d = document.createElement('div');
    d.className = 'emoji-float';
    d.textContent = em;
    d.style.left = (Math.random() * 80 + 20) + 'px';
    d.style.bottom = '100px';
    canvas.appendChild(d);
    setTimeout(() => d.remove(), 2000);
    if (broadcast && socket) socket.emit(EV.CALL_EMOJI, { emoji: em });
  }
  window.spawnEmoji = spawnEmoji;
  window.toggleEmojiPicker = function (forceHide) {
    const p = $('emoji-picker');
    if (forceHide === true) { p.classList.add('hidden'); return; }
    p.classList.toggle('hidden');
  };

  // ---------- Controls ----------
  window.toggleMic = function () {
    if (!localStream) { showToast('دسترسی به میکروفون وجود ندارد'); return; }
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    updateControlUI();
    broadcastStatus();
  };
  window.toggleCam = function () {
    if (!localStream) { showToast('دسترسی به دوربین وجود ندارد'); return; }
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    if (camOn && !sharing) { currentVideoTrack = cameraTrack; }
    else if (!camOn && !sharing) { currentVideoTrack = null; }
    updateSelfVideo();
    updateControlUI();
    broadcastStatus();
  };
  window.toggleShare = function () {
    if (sharing) { stopShare(); return; }
    navigator.mediaDevices.getDisplayMedia({ video: true }).then(screenStream => {
      screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.onended = stopShare;
      sharing = true;
      replaceOutgoingVideo(screenTrack);
      updateControlUI();
      broadcastStatus();
    }).catch(() => {});
  };
  function stopShare() {
    if (screenTrack) { screenTrack.stop(); screenTrack = null; }
    sharing = false;
    currentVideoTrack = camOn ? cameraTrack : null;
    replaceOutgoingVideo(currentVideoTrack);
    updateControlUI();
    broadcastStatus();
  }

  window.copyLink = function () {
    const url = I.publicUrl || location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => showToast('لینک کپی شد')).catch(() => showToast('لینک: ' + url));
    else showToast('لینک تماس: ' + url);
  };

  window.leaveCall = function () {
    if (socket) socket.emit(EV.CALL_LEAVE, {}, () => {});
    pcMap.forEach(({ pc }) => pc.close());
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    location.href = I.base + '/home.php';
  };

  // ---------- Admin actions (single socket path) ----------
  window.adminApprove = function (userId) {
    socket && socket.emit(EV.CALL_APPROVE, { userId });
  };
  window.adminReject = function (userId) {
    socket && socket.emit(EV.CALL_REJECT, { userId });
  };
  window.adminRemove = function (userId) {
    socket && socket.emit(EV.CALL_KICK, { userId });
  };
  window.adminBlockSelf = function (userId, kind) {
    localBlock[userId] = localBlock[userId] || {};
    localBlock[userId][kind] = !localBlock[userId][kind];
    applyMediaOverrides(userId);
    if (I.me.is_admin) renderAdminMembers(currentList);
  };
  window.adminDisableAll = function (userId, kind) {
    const st = memberStatus.get(userId) || {};
    const off = kind === 'audio' ? !st.muted : kind === 'video' ? (st.cam !== false) : (st.sharing !== false);
    socket && socket.emit(EV.CALL_DISABLE, { userId, kind, off });
  };

  // ---------- Tabs ----------
  window.switchTab = function (tab) {
    ['members', 'chat', 'admin'].forEach(t => {
      const c = $('content-' + t); if (c) { c.classList.add('hidden'); c.classList.remove('flex'); }
      const el = $('tab-' + t); if (el) { el.classList.remove('text-primary', 'border-primary'); el.classList.add('text-on-surface-variant', 'border-transparent'); }
    });
    const c2 = $('content-' + tab); if (c2) { c2.classList.remove('hidden'); c2.classList.add('flex'); }
    const a = $('tab-' + tab); if (a) { a.classList.add('text-primary', 'border-primary'); a.classList.remove('text-on-surface-variant', 'border-transparent'); }
  };

  // ---------- Right-click member menu ----------
  function openMemberMenu(e, userId, name) {
    e.preventDefault();
    menuUserId = userId;
    const la = localAudio[userId] || {};
    $('member-menu-name').textContent = name || 'عضو';
    $('mm-mute').checked = !!la.muted;
    $('mm-vol').value = (la.volume !== undefined) ? Math.round(la.volume * 100) : 100;
    const menu = $('member-menu');
    menu.classList.remove('hidden');
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
  }
  window.openMemberMenu = openMemberMenu;
  window.memberMenuMute = function (checked) {
    if (!menuUserId) return;
    localAudio[menuUserId] = localAudio[menuUserId] || {};
    localAudio[menuUserId].muted = checked;
    applyMediaOverrides(menuUserId);
  };
  window.memberMenuVolume = function (val) {
    if (!menuUserId) return;
    localAudio[menuUserId] = localAudio[menuUserId] || {};
    localAudio[menuUserId].volume = val / 100;
    applyMediaOverrides(menuUserId);
  };

  // ---------- Overrides & tile helpers ----------
  function applyMediaOverrides(userId) {
    const v = $('vid-' + userId), av = $('av-' + userId);
    if (!v) return;
    const blk = localBlock[userId] || {};
    const la = localAudio[userId] || {};
    const st = memberStatus.get(userId) || {};
    v.muted = !!(blk.audio || la.muted);
    v.volume = (la.volume !== undefined) ? la.volume : 1;
    const hideVideo = blk.video || st.cam === false;
    if (hideVideo) { v.style.display = 'none'; if (av) av.style.display = 'flex'; }
    else { v.style.display = ''; if (av) av.style.display = 'none'; }
  }
  function updateTileName(userId) {
    const el = $('name-' + userId);
    if (!el) return;
    const nm = memberNames.get(userId) || (peerMeta.get(userId) || {}).name;
    el.textContent = nm || 'بدون نام';
  }
  function layoutGrid() {
    if (!grid) return;
    grid.style.display = 'grid';
    grid.style.gap = '1rem';
    grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))';
  }
  window.addEventListener('resize', layoutGrid);

  function updateTileStatus(userId) {
    const st = memberStatus.get(userId) || {};
    const mic = $('mic-' + userId);
    if (mic) {
      mic.textContent = st.muted ? 'mic_off' : 'mic';
      mic.classList.toggle('text-error', !!st.muted);
      mic.classList.toggle('text-secondary', !st.muted);
    }
    applyMediaOverrides(userId);
  }

  // ---------- Init ----------
  let mediaReady = false;
  function init() {
    renderSelf();
    if (!approved) $('waiting-overlay').classList.remove('hidden');
    // bootstrap tiles from SSR data (HTTP bootstrap rule) — realtime updates take over after join
    if (I.participants && I.participants.length) {
      const mapped = I.participants.map(p => ({
        userId: p.user_id, name: p.display_name, username: p.username,
        status: p.status, is_admin: (p.role === 'admin'),
        muted: !!p.muted, cam: !!p.cam_on, sharing: !!p.sharing,
        avatar_color: p.avatar_color, avatar: p.avatar
      }));
      mapped.forEach(m => {
        memberNames.set(m.userId, m.name);
        if (m.userId !== I.me.id && m.status === 'approved') getOrCreateTile(m.userId, m);
      });
      currentList = mapped;
      mapped.forEach(renderOneMember);
      renderPendingCards();
    }
    (I.messages || []).forEach(m => appendMessage(m.user_id, m.display_name, m.body, m.user_id === I.me.id));
    (I.emojis || []).forEach(e => spawnEmoji(e.emoji, false));
    buildEmojiGrid();
    layoutGrid();
    const mm = $('member-menu');
    if (mm) mm.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { const m = $('member-menu'); if (m) m.classList.add('hidden'); });

    startMedia().then(() => {
      mediaReady = true;
      connectSocket();
      // if socket already connected (fast reconnect), join now
      if (socket && socket.connected) doJoin();
    });
  }
  init();
})();
