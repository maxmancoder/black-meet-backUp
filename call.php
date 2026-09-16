<?php
$title = 'تماس - Black Meet';
require_once __DIR__ . '/auth.php';
require_login();
require_once __DIR__ . '/partials/head.php';

$room = trim($_GET['room'] ?? '');
if ($room === '') { header('Location: ' . base_url() . '/home.php'); exit; }

$pdo = db_connect();
$stmt = $pdo->prepare('SELECT * FROM meetings WHERE room_id=? AND active=1');
$stmt->execute([$room]);
$meeting = $stmt->fetch();
if (!$meeting) { header('Location: ' . base_url() . '/home.php?err=nomeeting'); exit; }

$me = current_user();
ensure_schema_extras();

// block check: if this user is blocked from this meeting, deny access
$stmt = $pdo->prepare('SELECT 1 FROM meeting_blocks WHERE meeting_id=? AND user_id=?');
$stmt->execute([$meeting['id'], $me['id']]);
if ($stmt->fetchColumn()) {
    header('Location: ' . base_url() . '/home.php?err=blocked');
    exit;
}

// ensure participant row
$stmt = $pdo->prepare('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?');
$stmt->execute([$meeting['id'], $me['id']]);
$part = $stmt->fetch();
if (!$part) {
    $stmt = $pdo->prepare('INSERT INTO meeting_participants (meeting_id,user_id,display_name,username,status,role) VALUES (?,?,?,?,?,?)');
    $stmt->execute([$meeting['id'], $me['id'], $me['display_name'], $me['username'], 'pending', 'member']);
    $part = ['id' => $pdo->lastInsertId(), 'status' => 'pending', 'role' => 'member'];
} elseif ($part['status'] === 'removed') {
    $pdo->prepare('UPDATE meeting_participants SET status=? WHERE id=?')->execute(['pending', $part['id']]);
    $part['status'] = 'pending';
}
$is_admin = ($part['role'] === 'admin');
$my_status = $part['status'];

// participant list (excluding removed)
$stmt = $pdo->prepare('SELECT id,user_id,display_name,username,status,role,muted,cam_on,sharing
                       FROM meeting_participants WHERE meeting_id=? AND status<>? ORDER BY id');
$stmt->execute([$meeting['id'], 'removed']);
$participants = $stmt->fetchAll();

// chat history
$stmt = $pdo->prepare('SELECT user_id,display_name,body,created_at FROM messages WHERE meeting_id=? ORDER BY id DESC LIMIT 50');
$stmt->execute([$meeting['id']]);
$messages = array_reverse($stmt->fetchAll());

// recent emojis
$stmt = $pdo->prepare('SELECT user_id,display_name,emoji FROM emoji_events WHERE meeting_id=? ORDER BY id DESC LIMIT 12');
$stmt->execute([$meeting['id']]);
$emojis = $stmt->fetchAll();

$token = make_socket_token($me['id'], $meeting['id']);

$init = [
    'meeting'   => ['id' => (int)$meeting['id'], 'room' => $meeting['room_id'], 'title' => $meeting['title']],
    'me'        => [
        'id' => (int)$me['id'], 'name' => $me['display_name'], 'username' => $me['username'],
        'avatar_color' => $me['avatar_color'], 'avatar' => $me['avatar'], 'is_admin' => (bool)$is_admin, 'status' => $my_status
    ],
    'token'     => $token,
    'socketUrl' => socket_url(),
    'iceServers' => turn_config(),
    'base'      => base_url(),
    'participants' => $participants,
    'messages'  => $messages,
    'emojis'    => $emojis,
    'csrf'      => csrf_token(),
    'publicUrl' => public_url() . '/call.php?room=' . $meeting['room_id'],
];
$initials = initials($me['display_name']);
?>
</head>
<body class="bg-background text-on-background h-screen overflow-hidden flex flex-col font-body-md antialiased">

<!-- Top bar -->
<header class="fixed top-0 w-full z-50 flex justify-between items-center px-3 sm:px-grid-margin py-md bg-background/80 backdrop-blur-xl shadow-md border-b border-white/5">
    <div class="flex items-center gap-2 sm:gap-md min-w-0">
        <a href="<?= base_url() ?>/home.php" class="text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined">arrow_forward</span></a>
        <span class="font-bold tracking-tight text-primary text-lg sm:font-display-md sm:text-display-md" dir="ltr">Black Meet</span>
        <span class="hidden md:inline text-on-surface-variant">/</span>
        <span id="meeting-title" class="hidden md:inline font-headline-md text-headline-md text-on-surface truncate"><?= e($meeting['title']) ?></span>
    </div>
    <div class="flex items-center gap-2 sm:gap-md">
        <button onclick="toggleSidebar()" id="btn-sidebar" class="relative flex items-center bg-surface-container-highest hover:bg-surface-bright px-3 py-2 rounded-full text-body-sm text-on-surface transition">
            <span class="material-symbols-outlined text-[20px]">group</span>
            <span id="sidebar-badge" class="hidden absolute -top-1 -right-1 w-3 h-3 bg-error rounded-full border-2 border-background"></span>
        </button>
        <button onclick="copyLink()" class="flex items-center gap-1 sm:gap-2 bg-surface-container-highest hover:bg-surface-bright px-3 py-2 rounded-full text-body-sm text-on-surface transition">
            <span class="material-symbols-outlined text-[20px]">link</span>
            <span class="hidden sm:inline">کپی لینک</span>
        </button>
        <div class="hidden sm:flex items-center gap-1 bg-surface-container-highest px-3 py-2 rounded-full" title="وضعیت اتصال زنده">
            <span id="conn-state" class="w-2 h-2 rounded-full bg-secondary"></span>
            <span class="material-symbols-outlined text-[18px] text-secondary">groups</span>
            <span id="participant-count" class="font-label-sm text-on-surface"><?= count($participants) ?></span>
        </div>
        <div class="sm:hidden flex items-center bg-surface-container-highest px-2.5 py-2 rounded-full" title="وضعیت اتصال زنده">
            <span id="conn-state" class="w-2 h-2 rounded-full bg-secondary"></span>
            <span id="participant-count" class="font-label-sm text-on-surface mr-1"><?= count($participants) ?></span>
        </div>
        <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-headline-md text-white" style="background:<?= e($me['avatar_color']) ?>"><?= e($initials) ?></div>
    </div>
</header>

<!-- Workspace -->
<!-- Sidebar backdrop (mobile) -->
<div id="sidebar-backdrop" class="hidden fixed inset-0 bg-black/50 z-30 md:hidden" onclick="toggleSidebar(false)"></div>

<div class="flex flex-1 pt-[64px] sm:pt-[76px] h-full relative">
    <!-- Sidebar -->
    <aside id="call-sidebar" class="fixed md:relative inset-y-0 left-0 top-[64px] sm:top-[76px] md:top-0 bottom-0 w-[85%] max-w-[320px] md:w-80 lg:w-96 md:max-w-none z-40 flex-shrink-0 bg-surface-container-low border-l border-outline-variant/20 flex flex-col shadow-xl transform -translate-x-full transition-transform duration-300 h-full">
        <div class="flex border-b border-outline-variant/20 px-sm pt-sm">
            <button class="flex-1 pb-3 text-center font-label-md text-primary border-b-2 border-primary transition-colors rounded-t-lg" id="tab-members" onclick="switchTab('members')">اعضا</button>
            <button class="flex-1 pb-3 text-center font-label-md text-on-surface-variant border-b-2 border-transparent transition-colors hover:text-on-surface rounded-t-lg" id="tab-chat" onclick="switchTab('chat')">چت</button>
            <?php if ($is_admin): ?>
            <button class="flex-1 pb-3 text-center font-label-md text-on-surface-variant border-b-2 border-transparent transition-colors hover:text-on-surface rounded-t-lg relative" id="tab-admin" onclick="switchTab('admin')">
                ادمین <span id="admin-badge" class="absolute top-0 right-2 w-2 h-2 bg-error rounded-full hidden"></span>
            </button>
            <?php endif; ?>
        </div>

        <div class="flex-1 overflow-hidden relative">
            <!-- Members -->
            <div class="absolute inset-0 p-md overflow-y-auto custom-scrollbar flex flex-col gap-sm" id="content-members">
                <div id="member-list"></div>
            </div>
            <!-- Chat -->
            <div class="absolute inset-0 p-md overflow-y-auto custom-scrollbar hidden flex-col justify-between" id="content-chat">
                <div id="chat-messages" class="flex flex-col gap-4"></div>
                <div class="mt-4 pt-4 border-t border-outline-variant/20 relative">
                    <input id="chat-input" class="w-full bg-surface-container rounded-lg border border-outline-variant/30 py-3 pr-4 pl-12 text-body-sm text-on-surface focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container transition-all" placeholder="پیام خود را بنویسید..." type="text" onkeydown="if(event.key==='Enter')sendChat()"/>
                    <button onclick="sendChat()" class="absolute left-2 top-[26px] text-primary hover:text-primary-fixed"><span class="material-symbols-outlined filled">send</span></button>
                </div>
            </div>
            <!-- Admin -->
            <?php if ($is_admin): ?>
            <div class="absolute inset-0 p-md overflow-y-auto custom-scrollbar hidden flex-col gap-sm" id="content-admin">
                <h3 class="font-label-md text-on-surface-variant mb-2">درخواست‌های ورود</h3>
                <div id="join-requests"></div>
                <h3 class="font-label-md text-on-surface-variant mb-2 mt-4">مدیریت اعضا</h3>
                <div id="admin-members"></div>
            </div>
            <?php endif; ?>
        </div>
    </aside>

    <!-- Video grid -->
    <main class="flex-1 bg-surface-container-lowest relative p-md overflow-y-auto custom-scrollbar">
        <div id="video-grid" class="call-grid pb-32"></div>
        <div class="absolute inset-0 pointer-events-none overflow-hidden" id="emoji-canvas"></div>
        <div id="waiting-overlay" class="hidden absolute inset-0 z-30 flex items-center justify-center bg-surface-container-lowest/80 backdrop-blur">
            <div class="text-center">
                <div class="spinner mx-auto mb-4"></div>
                <p class="font-headline-md text-headline-md text-on-surface">در انتظار تایید ادمین برای ورود به تماس...</p>
                <button onclick="alertAdmin()" class="mt-5 mx-auto flex items-center gap-2 bg-secondary-container text-on-secondary-container px-5 py-3 rounded-full font-label-md hover:opacity-90 transition">
                    <span class="material-symbols-outlined">campaign</span> اطلاع به ادمین
                </button>
            </div>
        </div>
    </main>
</div>

<!-- Bottom control bar -->
<nav class="fixed bottom-3 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 sm:gap-grid-gutter bg-surface-container-highest/60 backdrop-blur-lg border border-white/10 shadow-2xl shadow-black/40 rounded-full px-3 sm:px-6 py-2 sm:py-3 max-w-[calc(100vw-16px)]" dir="ltr">
    <button id="btn-mic" class="bg-white/5 text-on-surface rounded-full p-3 hover:bg-white/10 transition-all scale-110 active:scale-90 duration-150 flex flex-col items-center justify-center gap-1 min-w-[64px] group" onclick="toggleMic()">
        <span class="material-symbols-outlined text-[24px]" id="ic-mic">mic</span>
        <span class="font-label-sm text-label-sm text-primary opacity-0 group-hover:opacity-100 transition-opacity absolute -top-6 bg-background/90 px-2 py-0.5 rounded text-[10px]">Mic</span>
    </button>
    <button id="btn-cam" class="bg-white/5 text-on-surface rounded-full p-3 hover:bg-white/10 transition-all scale-110 active:scale-90 duration-150 flex flex-col items-center justify-center gap-1 min-w-[64px] group" onclick="toggleCam()">
        <span class="material-symbols-outlined text-[24px]" id="ic-cam">videocam</span>
        <span class="font-label-sm text-label-sm text-primary opacity-0 group-hover:opacity-100 transition-opacity absolute -top-6 bg-background/90 px-2 py-0.5 rounded text-[10px]">Camera</span>
    </button>
    <div class="w-px h-8 bg-white/10 mx-1"></div>
    <button id="btn-share" class="bg-white/5 text-on-surface rounded-full p-3 hover:bg-white/10 transition-all scale-110 active:scale-90 duration-150 flex flex-col items-center justify-center gap-1 min-w-[64px] group" onclick="toggleShare()">
        <span class="material-symbols-outlined text-[24px]">screen_share</span>
        <span class="font-label-sm text-label-sm text-primary opacity-0 group-hover:opacity-100 transition-opacity absolute -top-6 bg-background/90 px-2 py-0.5 rounded text-[10px]">Share</span>
    </button>
    <button class="bg-white/5 text-on-surface rounded-full p-3 hover:bg-white/10 transition-all scale-110 active:scale-90 duration-150 flex flex-col items-center justify-center gap-1 min-w-[64px] group relative" onclick="toggleEmojiPicker()">
        <span class="material-symbols-outlined text-[24px]">mood</span>
        <span class="font-label-sm text-label-sm text-primary opacity-0 group-hover:opacity-100 transition-opacity absolute -top-6 bg-background/90 px-2 py-0.5 rounded text-[10px]">Emoji</span>
    </button>
    <div class="w-px h-8 bg-white/10 mx-1"></div>
    <button class="bg-tertiary-container text-on-tertiary-container rounded-full p-3 hover:bg-error transition-all scale-110 active:scale-90 duration-150 flex flex-col items-center justify-center gap-1 min-w-[64px] group" onclick="leaveCall()">
        <span class="material-symbols-outlined text-[24px]">call_end</span>
        <span class="font-label-sm text-label-sm text-primary opacity-0 group-hover:opacity-100 transition-opacity absolute -top-6 bg-background/90 px-2 py-0.5 rounded text-[10px]">Leave</span>
    </button>
</nav>

<!-- Emoji picker popup -->
<div id="emoji-picker" class="hidden fixed bottom-20 sm:bottom-24 left-1/2 -translate-x-1/2 z-[60] glass-panel rounded-2xl p-3 sm:p-4 shadow-2xl max-w-[calc(100vw-24px)]">
    <div class="grid grid-cols-6 gap-2" id="emoji-grid"></div>
</div>

<!-- Right-click member context menu -->
<div id="member-menu" class="hidden fixed z-[70] glass-panel rounded-xl p-3 shadow-2xl w-56">
    <div class="font-label-md text-on-surface mb-3 truncate" id="member-menu-name"></div>
    <label class="flex items-center justify-between text-body-sm text-on-surface mb-3 cursor-pointer">
        <span>بی‌صدا برای من</span>
        <input type="checkbox" id="mm-mute" onchange="memberMenuMute(this.checked)"/>
    </label>
    <div class="flex items-center justify-between text-body-sm text-on-surface gap-2">
        <span>صدا</span>
        <input type="range" min="0" max="100" value="100" class="flex-1" id="mm-vol" oninput="memberMenuVolume(this.value)"/>
    </div>
</div>

<!-- Toast -->
<div class="fixed bottom-6 right-6 hidden z-50" id="toast"><div class="bg-error-container text-on-error-container px-6 py-3 rounded-lg shadow-xl flex items-center gap-3">
    <span class="material-symbols-outlined">error</span><span id="toast-message"></span></div></div>

<script src="<?= e($init['socketUrl']) ?>/socket.io/socket.io.js"></script>
<script>window.INIT = <?= json_encode($init, JSON_UNESCAPED_UNICODE) ?>;</script>
<script>
  // Sidebar open/close: one button toggles chat/members/admin on ALL screen sizes.
  window.toggleSidebar = function (force) {
    const sb = document.getElementById('call-sidebar');
    const bd = document.getElementById('sidebar-backdrop');
    const btn = document.getElementById('btn-sidebar');
    const isMobile = window.innerWidth < 768;
    const hidden = sb.classList.contains('-translate-x-full');
    const show = force !== undefined ? force : hidden;
    sb.classList.toggle('-translate-x-full', !show);
    if (bd) bd.classList.toggle('hidden', !(show && isMobile));
    if (btn) {
      btn.classList.toggle('bg-secondary-container', show);
      btn.classList.toggle('text-on-secondary-container', show);
      btn.classList.toggle('bg-surface-container-highest', !show);
    }
  };
  // On first load: open on desktop, closed on mobile
  window.addEventListener('DOMContentLoaded', () => {
    toggleSidebar(window.innerWidth >= 768);
  });
</script>
<script src="<?= base_url() ?>/assets/js/call.js"></script>
</body>
</html>
