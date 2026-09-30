// assets/js/admin_members.js
(function () {
  const $ = id => document.getElementById(id);
  let allUsers = window.INIT_USERS || [];

  function showToast(msg) {
    const t = $('toast'); $('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function statusCell(u) {
    if (u.is_manager) {
      return '<span class="inline-flex items-center gap-1 text-white bg-gradient-to-br from-amber-500 to-orange-600 px-2 py-1 rounded-full font-label-sm shadow-lg">' +
        '<span class="material-symbols-outlined text-[16px]">shield_person</span> مدیر</span>';
    }
    if (u.is_limited) {
      return '<span class="inline-flex items-center gap-1 text-error-container bg-error-container/20 px-2 py-1 rounded-full font-label-sm">' +
        '<span class="material-symbols-outlined text-[16px]">block</span> محدود</span>';
    }
    return '<span class="inline-flex items-center gap-1 text-secondary-container bg-secondary-container/20 px-2 py-1 rounded-full font-label-sm">' +
      '<span class="material-symbols-outlined text-[16px]">check_circle</span> عادی</span>';
  }

  function actionCell(u) {
    if (u.is_manager) return '<span class="font-body-sm text-on-surface-variant">—</span>';
    const limited = !!u.is_limited;
    const cls = limited ? 'bg-secondary-container text-on-secondary-container' : 'bg-error-container/80 text-on-error-container';
    const label = limited ? 'رفع محدودیت' : 'محدود کردن';
    return '' +
      '<button id="btn-lim-' + u.id + '" onclick="toggleLimit(' + u.id + ')" class="text-[12px] px-3 py-1.5 rounded-md ' + cls + ' hover:opacity-80 transition-opacity">' + label + '</button>' +
      '<button onclick="resetPassword(' + u.id + ')" class="text-[12px] px-3 py-1.5 rounded-md bg-surface-container-high text-on-surface hover:opacity-80 transition-opacity">تغییر رمز</button>';
  }

  function avatarHtml(u, size) {
    const sz = size || 'w-9 h-9';
    const initial = esc((u.display_name || '?').slice(0, 2));
    if (u.avatar) {
      const src = (u.avatar.indexOf('http') === 0) ? u.avatar : (window.BASE + '/' + u.avatar.replace(/^\/+/, ''));
      return '<div class="' + sz + ' rounded-full overflow-hidden border border-outline-variant flex items-center justify-center text-white text-[12px]" style="background:' + esc(u.avatar_color) + '"><img src="' + esc(src) + '" class="w-full h-full object-cover" alt=""/></div>';
    }
    return '<div class="' + sz + ' rounded-full flex items-center justify-center text-white text-[12px]" style="background:' + esc(u.avatar_color) + '">' + initial + '</div>';
  }

  function cardEl(u) {
    const card = document.createElement('div');
    card.id = 'user-row-' + u.id;
    card.className = 'bg-surface-container-low rounded-xl border border-outline-variant/20 p-4 flex flex-col gap-3 bm-soft';
    card.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        ${avatarHtml(u, 'w-12 h-12 flex-shrink-0')}
        <div class="min-w-0 flex-1">
          <h3 class="font-body-sm font-semibold text-on-surface truncate">${esc(u.display_name)}</h3>
          <p class="font-label-sm text-on-surface-variant truncate" dir="ltr">@${esc(u.username)}</p>
        </div>
        <div id="lim-${u.id}" class="flex-shrink-0">${statusCell(u)}</div>
      </div>
      <div class="flex flex-col gap-1.5 text-[13px] leading-6 min-w-0">
        <div class="flex items-center gap-2 min-w-0"><span class="material-symbols-outlined text-[16px] text-on-surface-variant flex-shrink-0">badge</span><span class="font-body-sm text-on-surface truncate">${esc(u.full_name)}</span></div>
        <div class="flex items-center gap-2 min-w-0"><span class="material-symbols-outlined text-[16px] text-on-surface-variant flex-shrink-0">email</span><span class="font-body-sm text-on-surface-variant truncate" dir="ltr">${esc(u.email)}</span></div>
        <div class="flex items-center gap-2 min-w-0"><span class="material-symbols-outlined text-[16px] text-on-surface-variant flex-shrink-0">key</span><span class="font-body-sm text-on-surface-variant truncate font-mono" dir="ltr">${u.is_manager ? '•••••• (هش‌شده)' : esc(u.password_hash)}</span></div>
        <div class="flex items-center gap-2 min-w-0"><span class="material-symbols-outlined text-[16px] text-on-surface-variant flex-shrink-0">phone</span><span class="font-body-sm text-on-surface-variant" dir="ltr">${esc(u.phone)}</span></div>
        <div class="flex items-center gap-2"><span class="material-symbols-outlined text-[16px] text-on-surface-variant flex-shrink-0">shield_person</span><span class="font-body-sm text-on-surface">${u.is_manager ? 'مدیر' : 'عضو'}</span></div>
      </div>
      <div id="act-${u.id}" class="flex gap-2 flex-wrap pt-1 border-t border-outline-variant/10 items-center">${actionCell(u)}</div>`;
    return card;
  }

  function render() {
    const q = ($('member-search').value || '').trim().toLowerCase();
    const size = parseInt($('page-size').value, 10) || 25;
    let list = allUsers;
    if (q) {
      list = allUsers.filter(u =>
        (u.display_name || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.phone || '').includes(q)
      );
    }
    const shown = list.slice(0, size);
    const box = $('user-cards');
    box.innerHTML = '';
    if (!shown.length) {
      box.innerHTML = '<div class="col-span-full border border-dashed border-outline-variant rounded-xl p-6 text-center text-on-surface-variant font-body-sm">موردی یافت نشد</div>';
    } else {
      const frag = document.createDocumentFragment();
      shown.forEach(u => frag.appendChild(cardEl(u)));
      box.appendChild(frag);
    }
    $('result-count').textContent = list.length + ' کاربر' + (list.length > shown.length ? ' (نمایش ' + shown.length + ' مورد)' : '');
  }

  $('member-search').addEventListener('input', render);
  $('page-size').addEventListener('change', render);

  window.toggleLimit = function (userId) {
    const btn = $('btn-lim-' + userId);
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    fetch('api/admin/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: window.CSRF, user_id: String(userId) })
    })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); if (btn) { btn.disabled = false; btn.textContent = 'تلاش مجدد'; } return; }
        const u = allUsers.find(x => x.id === userId);
        if (u) u.is_limited = d.is_limited ? 1 : 0;
        render();
        showToast(d.is_limited ? 'کاربر محدود شد' : 'محدودیت برداشته شد');
      })
      .catch(() => { showToast('خطای شبکه'); if (btn) { btn.disabled = false; btn.textContent = 'تلاش مجدد'; } });
  };

  let pwdResetUserId = null;

  window.resetPassword = function (userId) {
    pwdResetUserId = userId;
    const u = allUsers.find(x => x.id === userId);
    document.getElementById('pwd-target').textContent = u
      ? (u.display_name || u.username || ('کاربر #' + userId))
      : ('کاربر #' + userId);
    document.getElementById('pwd-input').value = '';
    document.getElementById('pwd-modal').classList.remove('hidden');
    document.getElementById('pwd-input').focus();
  };

  window.closePwdModal = function () {
    document.getElementById('pwd-modal').classList.add('hidden');
    pwdResetUserId = null;
  };

  window.submitPasswordReset = function () {
    const userId = pwdResetUserId;
    const np = document.getElementById('pwd-input').value.trim();
    if (userId == null) return;
    const btn = document.querySelector('#pwd-modal .btn-primary, #pwd-modal button');
    if (btn) { btn.disabled = true; }
    fetch('api/admin/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: window.CSRF, user_id: String(userId), action: 'reset_password', new_password: np })
    })
      .then(r => r.json())
      .then(d => {
        if (btn) btn.disabled = false;
        if (!d.ok) { showToast(d.msg || 'خطا'); return; }
        showToast(d.generated ? ('رمز جدید: ' + d.generated) : 'رمز عبور به‌روزرسانی شد');
        closePwdModal();
      })
      .catch(() => { if (btn) btn.disabled = false; showToast('خطای شبکه'); });
  };

  render();
})();
