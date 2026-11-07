(function () {
  const $ = (id) => document.getElementById(id);
  const { esc } = PBCommon;
  let users = [];
  const PER_PAGE = 20;
  let userPage = 0, ledgerPageNo = 0, byIdCache = {};
  // Pager: « Prev  1 2 … 5  Next »  ·  "21–40 of 87"
  function renderPager(el, page, total, label, go) {
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (total <= PER_PAGE) { el.innerHTML = total ? '<span class="pg-info">' + total + ' ' + label + '</span>' : ''; return; }
    const nums = [];
    for (let i = 0; i < pages; i++) if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) nums.push(i); else if (nums[nums.length - 1] !== '…') nums.push('…');
    el.innerHTML = '<span class="pg-info">' + (page * PER_PAGE + 1) + '–' + Math.min(total, (page + 1) * PER_PAGE) + ' of ' + total + ' ' + label + '</span>' +
      '<div class="pg-btns"><button class="pg-num" data-p="' + (page - 1) + '"' + (page === 0 ? ' disabled' : '') + ' aria-label="Previous page">‹</button>' +
      nums.map((n) => n === '…' ? '<span class="pg-gap">…</span>' : '<button class="pg-num' + (n === page ? ' on' : '') + '" data-p="' + n + '">' + (n + 1) + '</button>').join('') +
      '<button class="pg-num" data-p="' + (page + 1) + '"' + (page >= pages - 1 ? ' disabled' : '') + ' aria-label="Next page">›</button></div>';
    el.querySelectorAll('button[data-p]').forEach((b) => b.onclick = () => go(Number(b.dataset.p)));
  }

  function show(id) {
    ['needLogin', 'notAdmin', 'notConfigured', 'panel', 'bootErr'].forEach((k) => $(k).classList.toggle('hidden', k !== id));
  }
  function fmt(d) { return d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function msg(t, kind) { const m = $('tMsg'); m.textContent = t; m.className = 'msg ' + (kind || ''); }

  // Copy each column header onto its cells so tables can become cards on phones
  function labelCells(tbodyId) {
    const tb = $(tbodyId); const table = tb.closest('table'); const heads = table.querySelectorAll('thead th');
    tb.querySelectorAll('tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (!td.hasAttribute('colspan')) td.setAttribute('data-label', heads[i] ? heads[i].textContent : ''); }));
  }
  function renderUsers() {
    const q = $('search').value.trim().toLowerCase();
    const all = users.filter((u) => !q || (u.email || '').includes(q) || (u.full_name || '').toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
    if (userPage > pages - 1) userPage = pages - 1;
    const list = all.slice(userPage * PER_PAGE, (userPage + 1) * PER_PAGE);
    renderPager($('usersPager'), userPage, all.length, all.length === 1 ? 'user' : 'users', (p) => { userPage = p; renderUsers(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    $('rows').innerHTML = list.map((u) => {
      const active = u.pass_until && new Date(u.pass_until) > new Date();
      return '<tr>' +
        '<td><div class="u">' + (u.avatar_url ? '<img src="' + esc(u.avatar_url) + '" alt="">' : '<img alt="">') +
        '<div><b>' + esc(u.full_name || '—') + (u.is_admin ? ' · admin' : '') + '</b><small>' + esc(u.email || '') + '</small></div></div></td>' +
        '<td class="num">' + (u.hours_balance || 0) + ' h</td>' +
        '<td class="' + (active ? 'pass-on' : '') + '">' + (active ? 'until ' + fmt(u.pass_until) : '—') +
          (u.live_until && new Date(u.live_until) > new Date() ? '<br><span class="live-tag">LIVE</span> until ' + fmt(u.live_until) : (u.live_hours ? '<br><span class="live-tag">LIVE</span> ' + u.live_hours + ' h ready' : '')) + '</td>' +
        '<td>' + (u.bound_device ? '<button class="mini-btn" data-reset="' + esc(u.id) + '" title="Allow this user to switch phones">Locked · reset</button>' : '<span style="color:var(--ink-3)">none</span>') + '</td>' +
        '<td><div class="quick">' + [[24, '+1 day'], [168, '+1 wk']].map(([n, l]) => '<button data-e="' + esc(u.email) + '" data-n="' + n + '">' + l + '</button>').join('') + '</div></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5" style="color:var(--ink-3)">No users yet. Users appear after their first Google sign-in.</td></tr>';
    labelCells('rows');
    $('rows').querySelectorAll('button[data-e]').forEach((b) => b.onclick = () => add(b.dataset.e, Number(b.dataset.n), 'Manual hours'));
    $('rows').querySelectorAll('button[data-reset]').forEach((b) => b.onclick = async () => {
      if (!confirm('Reset the phone lock? The user can then sign in on a new phone.')) return;
      try { await PBAuth.resetDevice(b.dataset.reset); msg('Phone lock reset.', 'ok'); loadAll(); } catch (e) { msg('Error: ' + e.message, 'bad'); }
    });
  }

  async function loadPayments(byId) {
    const pend = await PBAuth.adminPurchases('pending');
    const recent = (await PBAuth.adminPurchases()).filter((p) => p.status !== 'pending').slice(0, 30);
    const refCount = {};
    pend.concat(recent).forEach((p) => { refCount[p.reference] = (refCount[p.reference] || 0) + 1; });
    const who = (id) => esc((byId[id] && (byId[id].email)) || id.slice(0, 8));
    $('pendCount').textContent = pend.length; $('pendCount').classList.toggle('zero', !pend.length);
    if (window.__setPendingBadge) window.__setPendingBadge(pend.length);
    $('pending').innerHTML = pend.map((p) => '<tr><td>' + fmt(p.created_at) + '</td><td>' + who(p.user_id) + '</td><td>' + esc(p.package) + '</td>' +
      '<td class="num">PHP ' + p.amount_php + '</td><td><span class="ref">' + esc(p.reference) + '</span>' + (refCount[p.reference] > 1 ? '<span class="dup">same digits used before — check carefully</span>' : '') + '</td>' +
      '<td><div class="act"><button class="ok" data-ok="' + p.id + '">Approve</button><button class="no" data-no="' + p.id + '">Reject</button></div></td></tr>').join('') ||
      '<tr><td colspan="6" style="color:var(--ink-3)">Nothing to check right now.</td></tr>';
    labelCells('pending');
    $('pending').querySelectorAll('[data-ok]').forEach((b) => b.onclick = () => review(Number(b.dataset.ok), true));
    $('pending').querySelectorAll('[data-no]').forEach((b) => b.onclick = () => review(Number(b.dataset.no), false));
    $('reviewed').innerHTML = recent.map((p) => '<tr><td>' + fmt(p.reviewed_at || p.created_at) + '</td><td>' + who(p.user_id) + '</td><td>' + esc(p.package) + ' · PHP ' + p.amount_php + '</td><td class="ref">' + esc(p.reference) + '</td><td class="' + (p.status === 'approved' ? 'pass-on' : '') + '" style="' + (p.status === 'rejected' ? 'color:var(--danger)' : '') + '">' + esc(p.status) + '</td>' +
      '<td>' + (p.status === 'approved' ? '<button class="undo-btn" data-undo="' + p.id + '" title="Take the hours back and return this donation to “Donations to confirm”">Undo</button>' : '') + '</td></tr>').join('');
    $('reviewed').querySelectorAll('[data-undo]').forEach((b) => b.onclick = () => undoApproval(Number(b.dataset.undo)));
    labelCells('reviewed');
  }
  async function review(id, ok) {
    const note = ok ? '' : (prompt('Reason for rejecting (optional):') || '');
    if (ok && !confirm('Confirm this donation? Only approve if you received it.')) return;
    try {
      await PBAuth.reviewPurchase(id, ok, note);
      payMsg(ok ? '✅ Approved — the hours were added to the player’s time bank. Approved the wrong one?' : 'Rejected.', ok ? '' : 'warn', ok ? id : null);
      loadAll();
    }
    catch (e) { msg('Error: ' + e.message, 'bad'); }
  }

  // Result banner under "Donations to confirm", with an Undo button right after an approval
  function payMsg(text, kind, undoId) {
    const el = $('pMsg'); el.className = 'pay-msg ' + (kind || '');
    el.innerHTML = '<span>' + esc(text) + '</span>' + (undoId ? '<button class="undo-btn" id="pUndo">Undo approval</button>' : '');
    if (undoId) $('pUndo').onclick = () => undoApproval(undoId);
    clearTimeout(payMsg.t); payMsg.t = setTimeout(() => el.classList.add('hidden'), undoId ? 60000 : 15000);
  }
  async function undoApproval(id) {
    if (!confirm('Undo this approval?\n\n• The hours are taken back — first from the player’s unused time, then from their running pass (it gets shorter or ends now).\n• The donation goes back to “Donations to confirm” so you can check it again, then approve or reject it.\n• Time the player has already played can’t be taken back.')) return;
    try {
      const r = await PBAuth.undoApproval(id);
      const took = r.from_bank + r.from_pass;
      let t = '↩️ Approval undone — took back ' + took + ' of ' + r.hours + ' h';
      const parts = [];
      if (r.from_bank) parts.push(r.from_bank + ' h unused');
      if (r.from_pass) parts.push(r.from_pass + ' h from the running pass' + (r.pass_ended ? ', which has now ended' : ', which now ends ' + fmt(r.pass_until)));
      if (parts.length) t += ': ' + parts.join(' and ');
      t += '.';
      if (r.used) t += ' ' + r.used + ' h were already played and can’t be taken back.';
      t += ' The donation is back in “Donations to confirm”. A scoreboard in use picks this up within 5 minutes.';
      payMsg(t, r.used ? 'warn' : '');
      lastPending = null;   // the donation coming back to the list is not a new donation
      loadAll();
    } catch (e) {
      payMsg(e.message === 'NOT_APPROVED' ? 'This donation is no longer approved — nothing to undo.' : 'Could not undo: ' + e.message, 'bad');
      loadAll();
    }
  }

  /* ---------- LIVE trial codes ---------- */
  const fmtT = PBCommon.fmtTrial;
  async function loadTrials() {
    let list = [];
    try { list = await PBAuth.listLiveCodes(); } catch (e) { return; }
    const now = Date.now();
    $('trials').innerHTML = list.map((t) => {
      const until = t.redeemed_at ? new Date(t.redeemed_at).getTime() + t.minutes * 60000 : 0;
      const [cls, txt] = t.revoked ? ['off', 'Cancelled'] : t.redeemed_at ? (until > now ? ['active', 'In use · until ' + fmt(new Date(until))] : ['done', 'Used ' + fmt(t.redeemed_at)])
        : new Date(t.expires_at).getTime() < now ? ['done', 'Expired unused'] : ['unused', 'Not used yet'];
      return '<tr><td class="tcode">' + esc(fmtT(t.code)) + '</td><td>' + esc(t.note || '—') + '</td><td>' + fmt(t.created_at) + '</td><td><span class="tst ' + cls + '">' + esc(txt) + '</span></td>' +
        '<td>' + (!t.revoked && !t.redeemed_at && cls === 'unused' ? '<button class="mini-btn" data-cancel="' + esc(t.code) + '">Cancel</button>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" style="color:var(--ink-3)">No trial codes yet.</td></tr>';
    labelCells('trials');
    $('trials').querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Cancel trial code ' + fmtT(b.dataset.cancel) + '? It will stop working.')) return;
      try { await PBAuth.revokeLiveCode(b.dataset.cancel); loadTrials(); } catch (e) { alert('Could not cancel: ' + e.message); }
    });
  }
  let lastTrial = null;
  $('trialGo').onclick = async () => {
    $('trialGo').disabled = true;
    try {
      const note = $('trialNote').value.trim();
      const code = await PBAuth.createLiveCode(note);
      lastTrial = { code: fmtT(code), note };
      $('trialCode').textContent = lastTrial.code; $('trialFor').textContent = note ? 'For ' + note : 'Give this code to the organizer';
      $('trialNew').classList.remove('hidden'); $('trialNote').value = '';
      loadTrials();
    } catch (e) { alert('Could not generate a code: ' + e.message); }
    finally { $('trialGo').disabled = false; }
  };
  const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = o), 1500); } catch (e) { prompt('Copy this:', text); } };
  $('trialCopy').onclick = () => lastTrial && copy(lastTrial.code, $('trialCopy'));
  $('trialShare').onclick = () => lastTrial && copy('Your DinkyKong LIVE trial code: ' + lastTrial.code + '\nOpen https://dinkykong.pro on your TV or laptop, choose LIVE, then type the code under “Have a trial code?”. It unlocks LIVE (1–6 courts + OBS lower third) for 1 hour from when you enter it. Use it within 7 days.', $('trialShare'));

  async function loadAll() {
    try {
      users = await PBAuth.listUsers();
      renderUsers();
      const byId = Object.fromEntries(users.map((u) => [u.id, u]));
      await loadPayments(byId);
      byIdCache = byId;
      await loadLedger();
      loadTrials();
    } catch (e) { msg('Could not load: ' + e.message, 'bad'); }
  }

  async function loadLedger() {
    const byId = byIdCache;
    try {
      let { rows, total } = await PBAuth.ledgerPage(ledgerPageNo, PER_PAGE);
      if (!rows.length && ledgerPageNo > 0) { ledgerPageNo = Math.max(0, Math.ceil(total / PER_PAGE) - 1); ({ rows, total } = await PBAuth.ledgerPage(ledgerPageNo, PER_PAGE)); }
      renderPager($('ledgerPager'), ledgerPageNo, total, 'entries', (p) => { ledgerPageNo = p; loadLedger(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      $('ledger').innerHTML = rows.map((r) => '<tr><td>' + fmt(r.created_at) + '</td><td>' + esc((byId[r.user_id] && byId[r.user_id].email) || r.user_id.slice(0, 8)) + '</td>' +
        '<td class="num ' + (r.delta > 0 ? 'delta-pos' : 'delta-neg') + '">' + (r.delta > 0 ? '+' : '') + r.delta + '</td><td>' + esc(r.reason) + '</td></tr>').join('') ||
        '<tr><td colspan="4" style="color:var(--ink-3)">No activity yet.</td></tr>';
      labelCells('ledger');
    } catch (e) { msg('Could not load: ' + e.message, 'bad'); }
  }

  async function add(email, amount, note) {
    email = String(email || '').trim().toLowerCase();
    if (!email) return msg('Enter the user’s Google email.', 'bad');
    if (!Number.isInteger(amount) || amount === 0) return msg('Enter a whole number of hours (not 0).', 'bad');
    msg('Saving…');
    try {
      const bal = await PBAuth.addHours(email, amount, note);
      msg((amount > 0 ? 'Added ' + amount : 'Removed ' + -amount) + ' hours · ' + email + ' time bank is now ' + bal + ' h.', 'ok');
      loadAll();
    } catch (e) {
      const m = e.message;
      msg(m === 'USER_NOT_FOUND' ? email + ' has not signed in yet. Ask them to scan the scoreboard QR and sign in with Google once.' :
        m === 'NOT_ADMIN' ? 'Your account is not an admin.' : 'Error: ' + m, 'bad');
    }
  }

  $('tGo').onclick = () => add($('tEmail').value, parseInt($('tAmount').value, 10), $('tNote').value);
  $('search').oninput = () => { userPage = 0; renderUsers(); };
  $('reload').onclick = loadAll;
  $('loginBtn').onclick = () => PBAuth.signIn();
  let loginGis = false;
  async function mountLoginGis() {
    if (loginGis || !PBAuth.googleButtons) return; loginGis = true;
    const ok = await PBAuth.mountGoogleButton($('loginGis'), { theme: 'filled_black' });
    $('loginBtn').classList.toggle('hidden', ok); if (!ok) loginGis = false;
  }
  PBAuth.onGoogleError((m) => msg('Google sign-in failed: ' + m, 'bad'));
  $('logout').onclick = $('logout2').onclick = async () => { await PBAuth.signOut(); };

  PBAuth.onChange(() => {
    const u = PBAuth.user, p = PBAuth.profile;
    $('whoTxt').textContent = u ? u.email : 'Signed out';
    $('who').classList.toggle('ok', !!(p && p.is_admin));
    if (!PBAuth.enabled) return show('notConfigured');
    if (!u) { show('needLogin'); mountLoginGis(); return; }
    if (!p) return;                       // still loading
    if (!p.is_admin) { $('notAdminTxt').textContent = u.email + ' does not have admin access.'; return show('notAdmin'); }
    show('panel'); loadAll(); refreshAlertCard(); startLive();
    if (!window._adminPoll) window._adminPoll = setInterval(loadAll, 30000);
  });

  /* ---------- Donation alerts: live on this page + push to this device ---------- */
  let lastPending = null, live = null;
  function chime() {
    try {
      const A = new (window.AudioContext || window.webkitAudioContext)(); const now = A.currentTime;
      [880, 1320].forEach((f, i) => { const o = A.createOscillator(), g = A.createGain(); o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, now + i * .16); g.gain.exponentialRampToValueAtTime(0.25, now + i * .16 + .02); g.gain.exponentialRampToValueAtTime(0.0001, now + i * .16 + .35);
        o.connect(g).connect(A.destination); o.start(now + i * .16); o.stop(now + i * .16 + .4); });
    } catch (e) {}
    try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) {}
  }
  function liveToast(text) {
    const t = $('liveToast'); t.textContent = text; t.classList.remove('hidden');
    t.onclick = () => { t.classList.add('hidden'); if (window.__ownerTab) window.__ownerTab('don', true); $('pending').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    clearTimeout(liveToast.t); liveToast.t = setTimeout(() => t.classList.add('hidden'), 8000);
  }
  function onNewDonation(p) {
    chime();
    liveToast('💛 New donation' + (p && p.amount_php ? ' · PHP ' + p.amount_php : '') + (p && p.reference ? ' · ref …' + p.reference : '') + ' — tap to check');
    loadAll().then(() => { const r = $('pending').querySelector('tr:last-child'); if (r) r.classList.add('fresh'); });
  }
  function startLive() {
    if (live || !PBAuth.client) return;
    try {
      live = PBAuth.client.channel('owner-donations')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'purchases' }, (e) => onNewDonation(e.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'purchases' }, () => loadAll())
        .subscribe();
    } catch (e) { live = null; }
  }
  // Push from the service worker while the page is open (live channel may be asleep on a locked phone)
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.t === 'donation') loadAll(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && PBAuth.profile && PBAuth.profile.is_admin) loadAll(); });

  const pushOK = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  function b64ToU8(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
  async function currentSub() { if (!pushOK()) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
  function setAlertCard(on, title, body, btn) {
    $('alertCard').classList.toggle('on', on); $('alertTitle').textContent = title; $('alertBody').textContent = body;
    $('alertBtn').textContent = btn; $('alertBtn').classList.toggle('ghost', on);
  }
  async function refreshAlertCard() {
    if (!pushOK()) {
      if (isIOS && !PBCommon.isStandalone()) return setAlertCard(false, 'Install the Owner app to get alerts', 'On iPhone/iPad, alerts only work from the installed app: tap Share › “Add to Home Screen”, open it from your home screen, then turn on alerts. This page still updates live while open.', 'How to install');
      return setAlertCard(false, 'Alerts aren’t supported in this browser', 'Use Chrome or Edge (or the installed Owner app). This page still updates live with a chime while it’s open.', 'Check again');
    }
    if (Notification.permission === 'denied') return setAlertCard(false, 'Notifications are blocked', 'Allow notifications for dinkykong.pro in your browser or phone settings, then tap “Check again”. This page still updates live while open.', 'Check again');
    const sub = await currentSub().catch(() => null);
    if (sub && Notification.permission === 'granted') return setAlertCard(true, 'Donation alerts are on for this device', 'You’ll get a notification and a badge on the app icon the moment a player donates — even when this app is closed.', 'Send test alert');
    setAlertCard(false, 'Donation alerts are off on this device', 'Turn them on to get a notification and a badge on the app icon the moment a player donates — even when this app is closed.', 'Turn on alerts');
  }
  $('alertBtn').onclick = async () => {
    const label = $('alertBtn').textContent;
    if (label === 'How to install') { alert(PBCommon.installHelp()); return; }
    if (label === 'Check again') return refreshAlertCard();
    if (label === 'Send test alert') {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification('New donation · PHP 50', { body: 'Test alert · this is how donations will look.', icon: 'icons/admin-192.png', badge: 'icons/admin-192.png', tag: 'donation-test', data: { url: '/owner/' } });
      chime(); return;
    }
    try {
      $('alertBtn').disabled = true;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return refreshAlertCard();
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(window.PB_CONFIG.vapidPublicKey) });
      await PBAuth.savePush(sub);
      msg('Donation alerts are on for this device.', 'ok');
    } catch (e) { msg('Could not turn on alerts: ' + (e.message || e), 'bad'); }
    finally { $('alertBtn').disabled = false; refreshAlertCard(); }
  };
  function renderHoursNote() {
    const open = PBCommon.approvalOpen(), el = $('hoursNote');
    el.classList.toggle('off', !open);
    el.lastElementChild.innerHTML = open
      ? 'Confirmation hours: <b>8:00 AM – 10:00 PM</b> (PH time) · open now — players expect approval in 5 minutes to 2 hours.'
      : 'Confirmation hours: <b>8:00 AM – 10:00 PM</b> (PH time) · closed now — players are told donations sent now are confirmed after 8:00 AM.';
  }
  renderHoursNote(); setInterval(renderHoursNote, 60000);

  /* ---------- Install as an app ---------- */
  PBCommon.registerSW();
  PBCommon.installButton($('hdrInstall'), { onHelp: (h) => alert(h) });
  let deferredInstall = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const dismissed = PBCommon.store.get('aopb.installDismissed', 0) > Date.now() - 7 * 864e5;
  function showInstall(hint) {
    if (standalone || dismissed) return;
    if (hint) $('installHint').textContent = hint;
    $('installBar').classList.remove('hidden');
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; showInstall(); });
  window.addEventListener('appinstalled', () => { $('installBar').classList.add('hidden'); msg('Owner app installed.', 'ok'); });
  if (ios && !standalone) { $('installBtn').textContent = 'How?'; showInstall('On iPhone/iPad: tap the Share button, then “Add to Home Screen”.'); }
  $('installBtn').onclick = async () => {
    if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBar').classList.add('hidden'); }
    else if (ios) alert('Tap the Share button (square with an arrow) at the bottom of Safari, then choose “Add to Home Screen”.');
    else alert('Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”.');
  };
  $('installX').onclick = () => { $('installBar').classList.add('hidden'); PBCommon.store.set('aopb.installDismissed', Date.now()); };

  // Pending count on the app icon / tab title
  const baseTitle = document.title;
  window.__setPendingBadge = (n) => {
    if (lastPending !== null && n > lastPending && !live) onNewDonation(null);   // fallback when live updates aren't running
    lastPending = n;
    $('bellBadge').textContent = n; $('bellBadge').classList.toggle('hidden', !n);
    document.title = n ? '(' + n + ') ' + baseTitle : baseTitle;
    try { if ('setAppBadge' in navigator) { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
  };

  function boot() {
    $('whoTxt').textContent = 'Signing in…';
    const slow = setTimeout(() => { if ($('whoTxt').textContent === 'Signing in…') $('whoTxt').textContent = 'Still connecting…'; }, 6000);
    PBAuth.init().then(() => clearTimeout(slow)).catch((e) => {
      clearTimeout(slow);
      $('whoTxt').textContent = 'Not connected';
      show('bootErr'); $('bootErrTxt').textContent = String((e && e.message) || e);
    });
  }
  $('bootRetry').onclick = () => { show(null); boot(); };
  boot();
})();
