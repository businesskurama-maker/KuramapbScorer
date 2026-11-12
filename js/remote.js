(function () {
  const { seg, store, ICON, keepAwake, registerSW, loadScript, LIBS, PALETTE, esc } = PBCommon;
  const $ = (id) => document.getElementById(id);
  registerSW();

  $('iUndo').innerHTML = ICON.undo; $('iSwap').innerHTML = ICON.swap; $('iServe').innerHTML = ICON.serve; $('iGear').innerHTML = ICON.gear;

  let st = null;        // last state from display
  let link = null;
  let connected = false, leaving = false;
  let draft = null;     // settings being edited in the sheet
  const AUTH = PBAuth.enabled;
  let authed = !AUTH;   // TV has accepted this phone's sign-in
  let gateState = null; // 'signin' | 'checking' | 'denied' | null
  let lastAuthSend = 0;
  let device = store.get('aopb.device', null);
  if (!device) { device = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); store.set('aopb.device', device); }
  let lastDenied = null, pollT = null, authRetries = 0;

  const params = new URLSearchParams(location.search);
  const wantScan = params.get('scan') === '1';
  const liveRef = store.get('aopb.liveRef', null), liveRefOk = !!(liveRef && liveRef.code && Date.now() - liveRef.at < 6 * 3600e3);
  let code = PBLink.normCode(params.get('c') || (wantScan ? '' : store.get('aopb.remoteCode', '') || (liveRefOk ? liveRef.code : '')));
  // 'solo' = normal scoreboard · 'live' = a court on a LIVE screen (referee, no sign-in) · 'act' = organizer activating LIVE
  let mode = params.get('live') === '1' ? 'live' : params.get('act') === '1' ? 'act'
    : (code && code === store.get('aopb.remoteCode', '') ? store.get('aopb.remoteMode', 'solo') : (liveRefOk && code === liveRef.code ? 'live' : 'solo'));
  let scanMode = null;
  function setMode(m) {
    mode = m; store.set('aopb.remoteMode', m);
    document.body.classList.toggle('mode-live', m === 'live'); document.body.classList.toggle('mode-act', m === 'act');
    if (m === 'live') authed = true;
  }
  const modeQS = () => (mode === 'live' ? '&live=1' : mode === 'act' ? '&act=1' : '');
  try { localStorage.setItem('aopb.role', 'remote'); } catch (e) {}
  const touch = () => { try { localStorage.setItem('aopb.remoteAt', String(Date.now())); } catch (e) {} };

  /* Haptics.
     Android: Vibration API (Chrome needs the tap to count as a real user tap, so we call it on pointerdown AND,
     if that was refused, again on click).
     iPhone: Safari has no Vibration API; iOS 18+ gives a system haptic when a hidden <input switch> is toggled
     from a click, so we toggle a fresh one on every score tap. */
  // Score taps use a long, full-strength pulse: the web cannot set vibration strength, only length,
  // and a longer pulse lets the motor reach full power, so it feels much stronger.
  const TAP_MS = 90;
  let lastBuzz = 0, buzzOk = false, warnedHaptics = false;
  const CAN_VIB = typeof navigator.vibrate === 'function';
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IOS_VER = (() => { const m = navigator.userAgent.match(/OS (\d+)_/); return m ? Number(m[1]) : 0; })();
  function iosHaptic() {
    try {
      const l = document.createElement('label'); l.ariaHidden = 'true'; l.style.display = 'none';
      const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', '');
      l.appendChild(i); document.head.appendChild(l); l.click(); document.head.removeChild(l);
    } catch (e) {}
  }
  function buzz(ms) {
    lastBuzz = Date.now(); buzzOk = false;
    if (CAN_VIB) { try { buzzOk = navigator.vibrate(typeof ms === 'number' ? Math.max(30, ms) : (ms || 30)) !== false; } catch (e) { buzzOk = false; } }
    else { iosHaptic(); if (ms === TAP_MS) setTimeout(iosHaptic, 55); buzzOk = IOS && IOS_VER >= 18; }
    return buzzOk;
  }
  function hapticsNote() {
    if (warnedHaptics) return; warnedHaptics = true;
    if (!CAN_VIB && !(IOS && IOS_VER >= 18)) setTimeout(() => flash(IOS ? 'Tap vibration needs iOS 18 or newer' : 'This browser cannot vibrate · try Chrome'), 1500);
  }
  let flashT;
  function flash(t) { const f = $('flash'); f.textContent = t; f.classList.add('show'); clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 1400); }

  /* ---------- Status ---------- */
  let downSince = Date.now(), wasLive = false, kickT = null;
  /* Reliability: connection quality (round-trip time) and taps kept while reconnecting */
  var rtt = 0, queue = [];
  function flushQueue() {
    if (!queue.length || !link) return;
    const q = queue.splice(0); let sent = 0;
    for (const a of q) { if (link.send(a)) sent++; else { queue.unshift(...q.slice(sent)); break; } }
    if (sent) flash(sent + ' saved tap' + (sent > 1 ? 's' : '') + ' sent');
  }
  function setStatus(s) {
    if (leaving) return;
    // LIVE court: if the referee loses the court, they must scan the QR or enter the code again
    if (mode === 'live' && s === 'connected') wasLive = true;   // LIVE referees now reconnect by themselves (see the connection checker)
    if (s === 'connected') { downSince = 0; $('connHelp').classList.add('hidden'); }
    else if (!downSince) downSince = Date.now();
    if (s === 'connected' && !connected) setTimeout(sendAuth, 50);
    const el = $('status'), txt = $('statusTxt');
    el.classList.remove('ok', 'bad');
    connected = s === 'connected';
    const labels = { connected: 'Live · ' + code + (rtt ? ' · ' + rtt + ' ms' : ''), connecting: 'Connecting…', lost: 'Reconnecting…', nodisplay: 'Screen not found', nolib: 'Offline' };
    txt.textContent = labels[s] || s;
    if (s === 'connected') { el.classList.add('ok'); el.classList.toggle('slow', rtt > 400); flushQueue(); }
    if (s === 'nodisplay' || s === 'nolib') el.classList.add('bad');
    renderCtrl(); paintSound(); renderReconn();
  }

  /* ---------- Join ---------- */
  function showJoin(msg) {
    $('join').classList.remove('hidden'); $('ctrl').classList.add('hidden');
    $('joinErr').textContent = msg || '';
    $('codeIn').value = code || '';
    $('statusTxt').textContent = 'Not paired';
  }
  function join(c) {
    leaving = false;
    $('joinTitle').textContent = 'Scan the scoreboard'; $('joinHint').textContent = 'Point your camera at the QR code on the TV or tablet.';
    code = PBLink.normCode(c);
    if (code.length !== 6) { $('joinErr').textContent = 'Codes are 6 characters.'; return; }
    if (scanMode) { setMode(scanMode); scanMode = null; } else setMode(mode);
    store.set('aopb.remoteCode', code); touch(); stopScan();
    history.replaceState(null, '', 'remote.html?c=' + code + modeQS());
    if (mode === 'live') { store.del('aopb.remoteCode'); store.set('aopb.liveRef', { code, at: Date.now() }); history.replaceState(null, '', 'remote.html'); }   // remembered 6 h for auto-rejoin
    $('join').classList.add('hidden'); $('ctrl').classList.remove('hidden');
    if (link) link.destroy();
    link = PBLink.client({ code, onState, onStatus: setStatus, onMessage: onLinkMessage });
    keepAwake();
  }
  $('joinBtn').onclick = () => join($('codeIn').value);
  $('codeIn').addEventListener('input', (e) => { e.target.value = PBLink.normCode(e.target.value); });
  $('codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(e.target.value); });
  $('status').onclick = () => { if (!connected && code) { flash('Retrying…'); if (link) link.destroy(); join(code); } };

  /* ---------- Scoreboard sound on/off (one tap, top of the remote) ---------- */
  const SND_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  const SND_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
  function soundOn() { return !!(st && st.settings && st.settings.voice !== 0); }
  function paintSound() {
    const b = $('sndBtn'); if (!b) return;
    const show = !!(st && st.settings && !st.liveCourt);
    b.classList.toggle('hidden', !show); if (!show) return;
    const on = soundOn();
    b.classList.toggle('off', !on); $('sndIc').innerHTML = on ? SND_ON : SND_OFF; $('sndTxt').textContent = on ? 'SOUND ON' : 'MUTED';
  }
  $('sndBtn').onclick = () => {
    if (!st) return; const on = !soundOn();
    if (send({ a: 'voice', on })) { st.settings.voice = on ? 1 : 0; if (draft) draft.voice = on ? 1 : 0; paintSound(); flash(on ? 'Scoreboard sound ON' : 'Scoreboard muted'); try { buzz(on ? [20, 40, 20] : 40); } catch (e) {} }
  };

  /* ---------- State from display ---------- */
  function onState(s) {
    if (leaving) return;
    heard();
    if (s && s.liveCourt && mode !== 'live') { setMode('live'); setGate(null); store.del('aopb.remoteCode'); history.replaceState(null, '', 'remote.html'); }
    if (s && s.liveAct && mode !== 'act') setMode('act');
    { const rt = document.getElementById('refTour'); if (rt) rt.classList.toggle('hidden', !(s && s.liveCourt && s.tour1)); }
    touch();
    const prevEv = st && st.lastEvent ? st.lastEvent.t : 0;
    st = s;
    renderCtrl();
    if (s.lastEvent && s.lastEvent.t !== prevEv && prevEv) {
      const names = s.settings.names;
      const m = { pfs: names[s.serving] + ' serves first', pfsStart: 'Play for serve', partners: 'Positions fixed', sideout: 'Side out → ' + names[s.serving], second: '2nd server', game: 'Game → ' + names[s.lastEvent.team], match: 'Match → ' + names[s.lastEvent.team], swap: s.lastEvent.auto ? 'Switch ends!' : 'Sides swapped' };
      if (m[s.lastEvent.type]) { flash(m[s.lastEvent.type]); if (s.lastEvent.auto || s.lastEvent.type === 'game' || s.lastEvent.type === 'match') buzz([40, 60, 40]); }
    }
  }

  /* ---------- Sign-in / credits ---------- */
  function setGate(state, opts) {
    gateState = state;
    const g = $('gate'); opts = opts || {};
    g.classList.toggle('hidden', !state);
    const locked = state === 'denied' && opts.reason === 'OTHER_DEVICE';
    const liveEnded = state === 'denied' && opts.reason === 'LIVE_ENDED';
    const offer = state === 'denied' && !locked && !liveEnded;   // no pass (or a hiccup) → show packages, never a dead end
    shopKind = (state === 'denied' && (opts.reason === 'NO_LIVE_PASS' || mode === 'act')) ? 'live' : 'solo';
    g.classList.toggle('bad', locked);
    g.classList.toggle('offer', offer);
    $('gateGoogle').classList.toggle('hidden', state !== 'signin' || gisShown);
    $('gateGis').classList.toggle('hidden', state !== 'signin' || !gisShown);
    if (state === 'signin' && PBAuth.googleButtons && !gisShown) mountGis();
    $('gateRetry').classList.toggle('hidden', !(locked || liveEnded));
    $('gateSwitch').classList.toggle('hidden', !locked);
    $('gateBuy').classList.add('hidden');
    $('gatePkgs').classList.toggle('hidden', !offer);
    $('gateFund').classList.toggle('hidden', !(offer || state === 'signin'));
    $('gateLinks').classList.toggle('hidden', !offer);
    $('gateHours').classList.toggle('hidden', !offer); if (offer) renderHours();
    $('gateMark').classList.toggle('hidden', offer);
    if (offer) renderGatePkgs();
    if (state === 'denied') { lastDenied = opts; refreshPending(); } else $('gatePending').classList.add('hidden');
    const p = PBAuth.profile;
    if (state === 'signin') { $('gateTitle').textContent = 'Sign in to start scoring'; $('gateBody').textContent = 'Continue with Google. New here? Your first month is free — every feature, including LIVE for OBS. After that, a PHP 50 donation unlocks 24 hours.'; }
    if (state === 'checking') { $('gateTitle').textContent = 'Checking your pass…'; $('gateBody').textContent = 'One moment.'; }
    if (state === 'denied') {
      const who = opts.email || (p && p.email) || 'This account';
      $('gateTitle').textContent = locked ? 'Locked to another phone' : 'Support DinkyKong to start';
      $('gateBody').textContent = locked
        ? who + ' is already used on another phone. Passes work on one account and one phone only. Ask the owner to reset the phone lock if you changed phones.'
        : 'Signed in as ' + who + '. Pick a donation to the support fund, send it with InstaPay, and your scoring time unlocks once the developer confirms it.';
      if (opts.reason === 'OTHER_DEVICE') $('gateBody').textContent += ' Email dinkykongsupport@gmail.com.';
      if (!locked && p && p.trial_until && new Date(p.trial_until) <= new Date()) $('gateBody').textContent = 'Your 7 free days have ended — thanks for trying DinkyKong! ' + $('gateBody').textContent;
      if (liveEnded) { $('gateTitle').textContent = 'LIVE pass ended'; $('gateBody').textContent = 'The organizer’s LIVE pass for this screen has ended. Ask them to renew it on the LIVE screen, then tap Try again.'; }
      else if (shopKind === 'live' && !locked) { $('gateTitle').textContent = 'Get a LIVE pass'; $('gateBody').textContent = 'Signed in as ' + who + '. Pick how long you need LIVE — from PHP 20 per hour. It unlocks up to 6 courts on one screen, a referee remote for every court and the OBS lower third.'; }
    }
    if (state === 'signin' && mode === 'act') { $('gateTitle').textContent = 'Organizer sign-in'; $('gateBody').textContent = 'Sign in with Google to activate LIVE on this screen. New accounts get 7 free days. After that, a LIVE pass (from PHP 20 / hour) covers every court and the OBS lower third.'; }
    renderCtrl();
  }

  async function sendAuth(force) {
    if (!link || !connected) return;
    if (!AUTH) { if (mode === 'act') link.sendMsg({ t: 'auth', device }); return; }   // no sign-in configured: the LIVE screen opens straight away
    if (mode === 'live' && !force) { authed = true; return; }   // LIVE court: the organizer's LIVE pass covers referees
    if (!PBAuth.user) { authed = false; setGate('signin'); return; }
    if (!force && Date.now() - lastAuthSend < 4000) return;
    lastAuthSend = Date.now();
    const token = await PBAuth.accessToken();
    if (!token) { setGate('signin'); return; }
    setGate('checking');
    link.sendMsg({ t: 'auth', token, device });
  }

  async function silentAuth() {   // quiet pass re-check requested by the scoreboard
    if (!AUTH || !link || !connected || !PBAuth.user) return;
    const token = await PBAuth.accessToken(); if (!token) return;
    link.sendMsg({ t: 'auth', token, device, silent: true });
  }

  function onLinkMessage(m) {
    heard();
    if (leaving) return;
    if (m.t === 'rtt') { rtt = Math.max(1, Date.now() - m.at); if (connected) { $('statusTxt').textContent = 'Live · ' + code + ' · ' + rtt + ' ms'; $('status').classList.toggle('slow', rtt > 400); } return; }
    if (m.t === 'tourOk' && mode === 'live') { flash('Tournament restarted · match 1 is on court'); buzz([40, 60, 40]); return; }
    if (m.t === 'tourErr' && mode === 'live') { flash(m.reason || 'Could not restart'); return; }
    if (onClubMsg(m) || onTourMsg(m)) return;
    if (m.t === 'authok' && m.silent) { authed = true; if (mode === 'solo') { clubOK = !AUTH || !!m.brand; renderClub(); } return; }
    if (m.t === 'authok' && mode === 'act') { authRetries = 0; authed = true; setGate(null); showActDone(m); buzz([40, 60, 40]); return; }
    if (m.t === 'authok' && mode === 'live') { authed = true; setGate(null); return; }
    if (m.t === 'authok') { authRetries = 0; authed = true; setGate(null); clubAuth(m); PBAuth.refresh(); if (m.until) flash('Pass until ' + new Date(m.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); buzz([30, 40, 30]); }
    else if (m.t === 'denied') {
      authed = false;
      if (m.reason === 'ERROR' && authRetries < 2) { authRetries++; setTimeout(() => sendAuth(true), 2500); return; }
      authRetries = 0; setGate('denied', m); if (m.reason === 'OTHER_DEVICE') buzz([80, 60, 80]);
    }
    else if (m.t === 'reauth' || m.t === 'needauth') { authed = false; sendAuth(); }
    else if (m.t === 'recheck') { silentAuth(); }
    else if (m.t === 'reset') { leaveScreen(false, 'The scoreboard restarted for new players. Scan its new QR code to play again.'); }
  }

  /* Leave the scoreboard: optionally tell it to restart for the next players, then go back to the scan screen. */
  function leaveScreen(notify, msg) {
    if (link && notify) { try { link.sendMsg({ t: 'release' }); } catch (e) {} }
    leaving = true;
    const l = link; link = null; st = null; connected = false; authed = false;
    setTimeout(() => { try { l && l.destroy(); } catch (e) {} }, notify ? 600 : 0);
    store.del('aopb.remoteCode'); store.del('aopb.remoteMode'); store.del('aopb.liveRef'); code = ''; setMode('solo'); $('actDone').classList.add('hidden');
    $('status').classList.remove('ok', 'bad');
    history.replaceState(null, '', 'remote.html');
    setGate(null); closeSheet(); showJoin(msg || '');
  }

  /* Confirmation hours (8 AM – 10 PM PH time): tell players when to expect approval */
  function hoursText(short) {
    const open = PBCommon.approvalOpen();
    if (short) return open ? '🟢 Confirming donations now · ' + PBCommon.HOURS.label + ' daily' : '🌙 Donations are confirmed ' + PBCommon.HOURS.label + '. Sent now? It will be confirmed after 8:00 AM.';
    return open ? 'Usually confirmed within 5 minutes to 2 hours (confirmations run ' + PBCommon.HOURS.label + ' daily).' : 'It’s outside confirmation hours (' + PBCommon.HOURS.label + ', PH time), so it will be confirmed after 8:00 AM.';
  }
  function renderHours() {
    const open = PBCommon.approvalOpen();
    const sh = $('shopHours'); sh.textContent = hoursText(true); sh.classList.toggle('off', !open);
    const gh = $('gateHours'); gh.textContent = hoursText(true); gh.classList.toggle('off', !open);
    $('doneNote').innerHTML = open
      ? 'The developer will confirm your donation and unlock your scoring time within <b>5 minutes to 2 hours</b>. This screen updates by itself — keep it open, or come back later.'
      : 'It’s outside confirmation hours (<b>' + PBCommon.HOURS.label + '</b>, PH time). Your donation will be confirmed <b>after 8:00 AM</b> and your scoring time unlocks then. This screen updates by itself.';
  }
  setInterval(renderHours, 60000);

  /* ---------- Support fund donation (InstaPay P2P, confirmed by the owner) ---------- */
  let pkgList = [], chosen = null, shopKind = 'solo', pkgKind = '';
  const php = (n) => 'PHP ' + Number(n).toLocaleString();
  function shopView(v) { ['shopPick', 'shopPay', 'shopDone'].forEach((id) => $(id).classList.toggle('hidden', id !== v)); }
  async function openShop() {
    renderHours();
    $('shop').classList.remove('hidden'); shopView('shopPick');
    pkgList = await PBAuth.packages(shopKind); pkgKind = shopKind;
    $('pkgs').innerHTML = pkgList.map((k) => '<button class="pkg" data-c="' + esc(k.code) + '"><span>' + esc(k.label) + '</span><b>' + php(k.price_php) + '</b><small>' + (k.kind === 'live' ? (k.hours < 24 ? k.hours + (k.hours === 1 ? ' hour' : ' hours') : (k.hours / 24) + (k.hours === 24 ? ' day' : ' days')) + ' · all courts + OBS' : k.hours + ' hours of scoring') + '</small></button>').join('');
    $('pkgs').querySelectorAll('.pkg').forEach((b) => b.onclick = () => choose(b.dataset.c));
    renderMine();
  }
  async function renderGatePkgs() {
    if (!pkgList.length || pkgKind !== shopKind) { pkgList = await PBAuth.packages(shopKind); pkgKind = shopKind; }
    $('gatePkgs').innerHTML = pkgList.map((k) => '<button class="pkg" data-c="' + esc(k.code) + '"><span>' + esc(k.label) + '</span><b>' + php(k.price_php) + '</b></button>').join('');
    $('gatePkgs').querySelectorAll('.pkg').forEach((b) => b.onclick = async () => { await openShop(); choose(b.dataset.c); });
  }
  function choose(codeP) {
    chosen = pkgList.find((k) => k.code === codeP); if (!chosen) return;
    $('paySum').textContent = chosen.label + ' · ' + php(chosen.price_php);
    $('payAmt').textContent = php(chosen.price_php);
    $('payRef').value = ''; $('payErr').textContent = '';
    shopView('shopPay'); setTimeout(() => $('payRef').focus(), 200);
  }
  $('payBack').onclick = () => shopView('shopPick');
  $('payRef').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
  $('paySend').onclick = async () => {
    const ref = $('payRef').value;
    if (ref.length !== 6) { $('payErr').textContent = 'Enter the last 6 digits of the reference number.'; return; }
    $('paySend').disabled = true; $('payErr').textContent = '';
    try {
      await PBAuth.requestPurchase(chosen.code, ref);
      renderHours(); shopView('shopDone'); buzz([30, 40, 30]); renderMine(); refreshPending(); startPoll();
    } catch (e) {
      const m = e.message;
      $('payErr').textContent = m === 'BAD_REFERENCE' ? 'The reference must be 6 digits.' : m === 'DUPLICATE_REFERENCE' ? 'You already sent this reference number.' :
        m === 'TOO_MANY_PENDING' ? 'You have 3 donations waiting to be confirmed. Please wait for the developer.' : m === 'NOT_SIGNED_IN' ? 'Please sign in first.' : 'Could not submit: ' + m;
    } finally { $('paySend').disabled = false; }
  };
  $('shopX').onclick = () => $('shop').classList.add('hidden');
  $('shop').addEventListener('click', (e) => { if (e.target.id === 'shop') $('shop').classList.add('hidden'); });
  $('gateBuy').onclick = openShop;
  $('gateAlready').onclick = async () => { await PBAuth.refresh(); refreshPending(); sendAuth(true); };
  $('accBuy').onclick = () => { closeSheet(); openShop(); };
  async function renderMine() {
    const list = await PBAuth.myPurchases();
    $('myPurchases').innerHTML = list.length ? '<span class="eyebrow">Your donations</span>' + list.map((p) =>
      '<div class="purchase"><span>' + esc(p.package) + ' · ' + php(p.amount_php) + ' · ref …' + esc(p.reference) + '</span><span class="st ' + esc(p.status) + '">' + esc(p.status) + '</span></div>').join('') : '';
    return list;
  }
  async function refreshPending() {
    const list = await PBAuth.myPurchases();
    const pend = list.filter((p) => p.status === 'pending');
    const el = $('gatePending');
    el.classList.toggle('hidden', !pend.length || gateState !== 'denied');
    if (pend.length && gateState === 'denied') { $('gateTitle').textContent = 'Thanks! Confirming your donation'; }
    el.textContent = pend.length ? pend.length + ' donation' + (pend.length > 1 ? 's' : '') + ' waiting to be confirmed. ' + hoursText(false) + ' This screen will unlock by itself.' : '';
    if (pend.length) startPoll();
  }
  function startPoll() {
    if (pollT) return;
    pollT = setInterval(async () => {
      const p = await PBAuth.refresh();
      const list = await renderMine();
      const liveReady = shopKind === 'live' && p && (p.live_hours > 0 || (p.live_until && new Date(p.live_until) > new Date()));
      if (p && (liveReady || (shopKind !== 'live' && (p.hours_balance > 0 || PBAuth.passActive())))) {
        clearInterval(pollT); pollT = null;
        $('shop').classList.add('hidden'); flash('Pass approved!'); buzz([40, 60, 40]);
        if (!authed) sendAuth(true);
      } else if (!list.some((x) => x.status === 'pending')) { clearInterval(pollT); pollT = null; refreshPending(); }
    }, 10000);
  }

  $('gateGoogle').onclick = () => PBAuth.signIn();
  // Google's own button (sign-in stays on dinkykong.pro). Falls back to the redirect button if it can't load.
  var gisShown = false, gisTrying = false;
  async function mountGis() {
    if (gisTrying) return; gisTrying = true;
    $('gateGis').classList.remove('hidden');
    const ok = await PBAuth.mountGoogleButton($('gateGis'), { theme: 'filled_black' });
    gisTrying = false; gisShown = ok;
    const signin = gateState === 'signin';
    $('gateGis').classList.toggle('hidden', !ok || !signin);
    $('gateGoogle').classList.toggle('hidden', ok || !signin);
  }
  PBAuth.onGoogleError((m) => flash('Google sign-in failed — try again'));
  // Signed in through Google's button (no page reload): continue to the pass check
  let wasUser = !!PBAuth.user;
  PBAuth.onChange(() => { const u = !!PBAuth.user; if (u && !wasUser && link && connected) { setGate('checking'); sendAuth(true); } wasUser = u; });
  $('gateRetry').onclick = async () => { await PBAuth.refresh(); if (mode === 'live' && link) { link.sendMsg({ t: 'auth', device }); return; } sendAuth(true); };
  // Switch to another Google account (e.g. the one that donated). Google's account picker opens.
  const switchAccount = async () => {
    if (!confirm('Switch to another Google account? You’ll sign out of ' + ((PBAuth.user && PBAuth.user.email) || 'this account') + ' and pick a different one.')) return;
    flash('Switching account…');
    try { sessionStorage.setItem('aopb.switched', '1'); } catch (e) {}
    leaveScreen(false);                       // disconnect from this scoreboard (it stays on its QR page)
    try { await PBAuth.signOut(); } catch (e) {}
    if (PBAuth.googleButtons) {               // Google button mode: scan again, then pick the other account on the sign-in screen
      try { sessionStorage.removeItem('aopb.switched'); } catch (e) {}
      $('joinTitle').textContent = 'Scan again to continue';
      $('joinHint').textContent = 'Signed out. Scan the scoreboard QR, then continue with your other Google account.';
      startScan(); return;
    }
    PBAuth.signIn('remote.html?scan=1');      // after picking the account, come back to the QR scanner
  };
  $('gateSwitch').onclick = switchAccount;
  $('gateSwitch2').onclick = switchAccount;
  $('accOut').onclick = async () => {
    if (!confirm('Sign out? The scoreboard will restart and show a new QR code for the next players.')) return;
    leaveScreen(true, 'Signed out. The scoreboard is restarting for the next players.');
    try { await PBAuth.signOut(); } catch (e) {}
  };

  function renderAccount() {
    const p = PBAuth.profile, u = PBAuth.user;
    $('account').classList.toggle('hidden', !AUTH || !u);
    if (!u) return;
    $('accName').textContent = (p && p.full_name) || u.email;
    const until = PBAuth.passActive() ? PBAuth.passUntil() : null;
    const fmtUntil = (d) => { const sameDay = d.toDateString() === new Date().toDateString();
      return (sameDay ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
    const pill = $('accInfo');
    pill.classList.toggle('on', !!until);
    const onTrial = until && p && p.trial_until && Math.abs(new Date(p.trial_until) - until) < 60000;
    pill.textContent = !p ? 'Loading…' : until ? (onTrial ? 'Free trial until ' : 'Pass until ') + fmtUntil(until) : (p.hours_balance ? p.hours_balance + ' h ready to use' : 'No scoring time');
    const av = (p && p.avatar_url) || (u.user_metadata && u.user_metadata.avatar_url);
    if (av) $('accAvatar').src = av;
  }
  PBAuth.onChange(renderAccount);

  function send(action) {
    if (!authed) { if (AUTH) sendAuth(true); flash(PBAuth.user ? 'Waiting for approval' : 'Sign in first'); return false; }
    if (!link || !link.send(action)) {
      // Lost the screen for a moment: keep score taps and send them in order when it is back
      if (link && ['rally', 'undo', 'tag'].includes(action.a) && queue.length < 12) { queue.push(action); flash('Saved · sends when reconnected'); buzz([20, 40, 20]); return true; }
      flash('Not connected'); buzz([20, 40, 20]); return false;
    }
    if (Date.now() - lastBuzz > 400) buzz(); return true;
  }

  function outcome(team) {
    if (!st) return '';
    if (st.pfs) return 'Serves first';
    const s = st.settings;
    if (s.scoring === 'rally') return team === st.serving ? 'Point' : 'Point + serve';
    if (team === st.serving) return 'Point';
    if (s.mode === 'doubles' && st.serverNum === 1) return '2nd server';
    return 'Side out';
  }

  function renderCtrl() {
    if (!st) {
      $('call').textContent = '—'; $('callX').textContent = connected ? 'Syncing…' : 'Waiting for screen';
      ['rL', 'rR'].forEach((id) => { $(id).disabled = true; $(id).querySelector('.nm').textContent = '—'; $(id).querySelector('.what').textContent = ''; });
      return;
    }
    const s = st.settings;
    const left = st.swapped ? 1 : 0, right = 1 - left;
    [[$('bL'), left], [$('bR'), right]].forEach(([el, t]) => {
      el.querySelector('.n span').textContent = s.names[t] + (st.serving === t && !st.matchOver && !st.pfs ? ' •' : '');
      el.querySelector('.n i').style.background = s.colors[t];
      el.querySelector('.s').innerHTML = seg(st.score[t], 2);
      el.querySelector('.s').style.color = s.colors[t];
      el.querySelector('.g').textContent = s.bestOf > 1 ? 'GAMES ' + st.games[t] : '';
    });
    $('call').innerHTML = st.pfs ? '<span class="pfs-call">SERVE RALLY</span>' : seg(st.call);
    $('callX').textContent = st.pfs ? 'Tap who won the rally' : (st.hasPlayers ? st.serverName + ' · ' : (s.bestOf > 1 ? 'Game ' + st.gameNo + ' · ' : '')) + 'serve ' + st.serveSide.toLowerCase();
    $('rallyBtns').classList.toggle('pfs', !!st.pfs);
    // Play for serve stays available until the first point of the match (also after an undo back to 0-0)
    const fresh = !st.pfs && st.gameNo === 1 && st.score[0] + st.score[1] === 0 && !st.matchOver && !st.gameOver;
    $('startRow').classList.toggle('hidden', !fresh || !!gateState);
    // Timeouts
    const to = st.timeout && st.timeout.until > Date.now() ? st.timeout : null;
    const left2 = st.swapped ? 1 : 0;
    [['toA', left2], ['toB', 1 - left2]].forEach(([id, t]) => { const b = $(id); b.dataset.team = t; b.firstChild.textContent = s.names[t] + ' '; b.querySelector('small').textContent = (st.timeouts ? st.timeouts[t] : 0) + ' left'; b.disabled = !st.timeouts || st.timeouts[t] < 1 || !!to; b.style.borderColor = s.colors[t]; });
    $('toRun').classList.toggle('hidden', !to); $('toPick').classList.toggle('hidden', !!to);
    if (to) $('toRunTxt').textContent = 'Timeout · ' + s.names[to.team];
    if (to && $('toPanel').classList.contains('hidden')) $('toPanel').classList.remove('hidden');
    renderTimeoutClock();
    $('toBtn').disabled = !connected || !authed || st.gameOver || st.matchOver || !s.timeouts;
    lastTagSetting = s.tags === 1;

    [[$('rL'), left], [$('rR'), right]].forEach(([b, t]) => {
      b.style.setProperty('--c', s.colors[t]);
      b.dataset.team = t;
      b.querySelector('.nm').textContent = s.names[t];
      b.querySelector('.what').textContent = outcome(t);
      b.querySelector('.who').innerHTML = st.hasPlayers && Array.isArray(st.court) && st.court[t] ? st.court[t].map((p) => p.serving ? '<b>● ' + esc(p.name) + '</b>' : esc(p.name)).join('<br>') : '';
      b.disabled = !connected || st.gameOver || st.matchOver;
      b.classList.toggle('is-serving', st.serving === t && !st.matchOver && !st.pfs);
    });

    const over = st.gameOver || st.matchOver;
    const gated = !!gateState;
    $('rallyBtns').classList.toggle('hidden', over || gated);
    $('nextBtn').classList.toggle('hidden', !over || gated);
    $('endBtns').classList.toggle('hidden', !st.matchOver || gated);
    if (st.matchOver) maybeSaveMatch();
    $('nextBtn').classList.toggle('match-over', !!st.matchOver);
    if (st.matchOver) $('nextBtn').innerHTML = '🏆 ' + esc(s.names[st.winner]) + ' WINS!<small>' + (st.gameLog.length > 1 ? 'Games ' + st.games[st.winner] + '–' + st.games[1 - st.winner] + ' · ' : '') + 'Tap to change teams or rules</small>';
    else if (st.gameOver) $('nextBtn').innerHTML = 'START GAME ' + (st.gameNo + 1) + '<small>' + esc(s.names[st.gameLog[st.gameLog.length - 1].winner]) + ' took game ' + st.gameNo + '</small>';

    $('undoBtn').disabled = !connected || !st.canUndo || !authed;
    $('swapBtn').disabled = !connected || !authed;
    $('serveBtn').disabled = !connected || st.score[0] + st.score[1] > 0 || over || !authed;
    $('setBtn').disabled = !connected || (!authed && !PBAuth.user);
  }

  /* ---------- Controls ---------- */
  ['rL', 'rR'].forEach((id) => {
    const b = $(id);
    // Vibrate the moment the finger lands; if the phone refused (no user tap yet), vibrate again on click
    b.addEventListener('pointerdown', () => { if (!b.disabled && CAN_VIB) buzz(TAP_MS); });
    b.addEventListener('click', () => {
      if (b.disabled) return;
      if (!CAN_VIB || !buzzOk || Date.now() - lastBuzz > 600) buzz(TAP_MS);
      hapticsNote();
      if (send({ a: 'rally', team: Number(b.dataset.team) })) showTags();
    });
  });
  $('undoBtn').onclick = () => { buzz([60, 40, 60]); send({ a: 'undo' }); };
  $('swapBtn').onclick = () => send({ a: 'swap' });
  $('serveBtn').onclick = () => { if (st) send({ a: 'server', team: 1 - st.serving }); };
  $('pfsBtn').onclick = () => { if (send({ a: 'pfs' })) flash('Play for serve'); };
  $('tossBtn').onclick = () => { if (send({ a: 'toss' })) { flash('Coin toss…'); buzz([20, 40, 20]); } };
  // Timeouts
  $('toBtn').onclick = () => { $('toPanel').classList.toggle('hidden'); };
  ['toA', 'toB'].forEach((id) => $(id).onclick = () => { if (send({ a: 'timeout', team: Number($(id).dataset.team) })) flash('Timeout'); });
  $('toEnd').onclick = () => { if (send({ a: 'timein' })) { flash('Time in'); $('toPanel').classList.add('hidden'); } };
  function renderTimeoutClock() {
    const to = st && st.timeout && st.timeout.until > Date.now() ? st.timeout : null;
    if (!to) return;
    const sec = Math.max(0, Math.ceil((to.until - Date.now()) / 1000));
    $('toLeft').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  setInterval(renderTimeoutClock, 500);
  // Rally reasons (optional): a quick row of chips after each rally
  var lastTagSetting = false, tagT = 0;
  function showTags() { if (!lastTagSetting) return; $('tagRow').classList.remove('hidden'); clearTimeout(tagT); tagT = setTimeout(() => $('tagRow').classList.add('hidden'), 3500); }
  $('tagRow').querySelectorAll('button').forEach((b) => b.onclick = () => { if (send({ a: 'tag', tag: b.dataset.tag })) { flash(b.textContent); $('tagRow').classList.add('hidden'); } });
  $('nextBtn').onclick = () => { if (!st) return; if (st.matchOver) openSheet(); else send({ a: 'next' }); };
  // After the winner is announced: rematch with the same teams, or leave
  $('endNew').onclick = () => { if (st) openTeamWiz('new'); };
  $('endExit').onclick = () => {
    if (!confirm('Exit? ' + (mode === 'live' ? 'This phone leaves the court.' : 'The scoreboard restarts and shows a new QR code for the next players.'))) return;
    leaveScreen(true, mode === 'live' ? 'You left the court.' : 'Thanks for playing! The scoreboard is ready for the next players.');
    setTimeout(toMenu, 700);
  };

  /* ---------- Settings sheet ---------- */
  function swatches(el, team) {
    el.innerHTML = PALETTE.slice(0, 6).map((c) => '<button class="sw" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>').join('');
    el.querySelectorAll('.sw').forEach((b) => b.onclick = () => {
      if (b.dataset.c.toLowerCase() === String(draft.colors[1 - team]).toLowerCase()) { flash((team ? 'Team A' : 'Team B') + ' already uses this color'); return; }
      draft.colors[team] = b.dataset.c; paintSheet();
    });
  }
  function paintSheet() {
    document.querySelectorAll('.seg[data-k]').forEach((seg) => {
      const k = seg.dataset.k;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(draft[k]) === b.dataset.v));
    });
    $('dotA').style.background = draft.colors[0]; $('dotB').style.background = draft.colors[1];
    [['swA', 0], ['swB', 1]].forEach(([id, t]) => $(id).querySelectorAll('.sw').forEach((b) => {
      const c = b.dataset.c.toLowerCase();
      b.classList.toggle('on', c === String(draft.colors[t]).toLowerCase());
      const taken = c === String(draft.colors[1 - t]).toLowerCase();   // the other team's color can't be picked
      b.classList.toggle('taken', taken); b.disabled = taken; b.title = taken ? 'Used by ' + (t ? 'Team A' : 'Team B') : '';
    }));
    $('fs0').textContent = ($('nA').value || 'Team A').slice(0, 10);
    $('fs1').textContent = ($('nB').value || 'Team B').slice(0, 10);
    const single = draft.mode === 'singles';
    document.querySelectorAll('.pl2, .dbl-only').forEach((el) => el.classList.toggle('hidden', single));
    document.querySelectorAll('.player-row').forEach((el) => el.classList.toggle('single', single));
    $('pA0').placeholder = $('pB0').placeholder = single ? 'Player name' : 'Player 1';
    syncRuleSelects();
  }
  /* Compact rules: every rule button row becomes a small dropdown in a 2-column grid */
  function buildRuleSelects() {
    const grid = $('rulesGrid'); if (!grid || grid.childElementCount) return;
    document.querySelectorAll('.rules-sec .field').forEach((f) => {
      const seg = f.querySelector('.seg[data-k]'); if (!seg) return;
      const eb = f.querySelector('.eyebrow'); const label = eb ? eb.childNodes[0].textContent.replace(/·.*$/, '').trim() : seg.dataset.k;
      const cell = document.createElement('label'); cell.className = 'rs-cell' + (f.classList.contains('voice-field') ? ' voice-field' : '');
      const sel = document.createElement('select'); sel.className = 'rs-sel'; sel.dataset.k = seg.dataset.k;
      seg.querySelectorAll('button').forEach((b) => { const o = document.createElement('option'); o.value = b.dataset.v; o.textContent = b.textContent; sel.appendChild(o); });
      sel.onchange = () => { const b = seg.querySelector('button[data-v="' + sel.value + '"]'); if (b) b.click(); };
      const SHORT = { target: 'Points to win', timeouts: 'Timeouts', tags: 'Rally reasons', voice: 'Voice calls', voicePack: 'Announcer', courtChange: 'Court change' };
      const sp = document.createElement('span'); sp.textContent = SHORT[seg.dataset.k] || label;
      cell.appendChild(sp); cell.appendChild(sel); grid.appendChild(cell);
      f.classList.add('as-select');
    });
  }
  function syncRuleSelects() {
    document.querySelectorAll('.rs-sel').forEach((sel) => {
      const seg = document.querySelector('.seg[data-k="' + sel.dataset.k + '"]');
      [...sel.options].forEach((o) => { const b = seg && seg.querySelector('button[data-v="' + o.value + '"]'); if (b) o.textContent = b.textContent; });
      sel.value = String(draft[sel.dataset.k]);
    });
  }
  document.querySelectorAll('.sheet-tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.sheet-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('#sheet .sheet > [data-tab]').forEach((sec) => sec.classList.toggle('tab-off', sec.dataset.tab !== b.dataset.tab));
    const sh = document.querySelector('#sheet .sheet'); if (sh) sh.scrollTop = 0;
  });
  function openSheet() {
    const base = st ? st.settings : PBEngine.DEFAULT_SETTINGS;
    draft = JSON.parse(JSON.stringify(base));
    $('nA').value = draft.names[0]; $('nB').value = draft.names[1]; $('lblIn').value = draft.label || '';
    const pls = (draft.players || [['', ''], ['', '']]);
    $('pA0').value = pls[0][0] || ''; $('pA1').value = pls[0][1] || ''; $('pB0').value = pls[1][0] || ''; $('pB1').value = pls[1][1] || '';
    swatches($('swA'), 0); swatches($('swB'), 1);
    buildRuleSelects(); paintSheet();
    $('sheet').classList.remove('hidden');
  }
  function closeSheet() { $('sheet').classList.add('hidden'); }
  $('lblForm').onsubmit = (e) => {   // match name / category: saved right away, no score reset
    e.preventDefault(); const v = $('lblIn').value.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40); $('lblIn').value = v;
    if (draft) draft.label = v;
    if (st && send({ a: 'label', text: v })) flash(v ? 'Match name saved' : 'Match name cleared');
  };
  document.querySelectorAll('.seg[data-k]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.onclick = () => {
    const k = seg.dataset.k; const v = b.dataset.v;
    draft[k] = /^\d+$/.test(v) ? Number(v) : v; paintSheet();
    if (['winBy', 'timeouts', 'tags'].includes(k) && st && send({ a: 'rules', rules: { [k]: draft[k] } })) flash('Updated');
    if (k === 'voice' && st && send({ a: 'voice', on: draft.voice === 1 })) flash(draft.voice ? 'Voice calls on' : 'Voice calls off');
    if (k === 'voicePack' && st && send({ a: 'voice', pack: draft.voicePack })) flash(({ classic: 'Classic voice', anime: 'Anime Hype voice' }[draft.voicePack] || 'Classic voice') + ' · listen to the TV');
    if (k === 'courtChange' && st && send({ a: 'midswap', on: draft.courtChange === 1 })) flash(draft.courtChange ? 'Court change at half: on' : 'No court change at half');
  }));
  ['nA', 'nB'].forEach((id) => $(id).addEventListener('input', paintSheet));
  function names() { return [$('nA').value.trim().toUpperCase() || 'TEAM A', $('nB').value.trim().toUpperCase() || 'TEAM B']; }
  function players() { return [[$('pA0').value.trim(), $('pA1').value.trim()], [$('pB0').value.trim(), $('pB1').value.trim()]]; }
  /* ---------- Saved teams & players (kept on this phone) ---------- */
  const SAVED_T = 'aopb.savedTeams', SAVED_P = 'aopb.savedPlayers';
  const savedTeams = () => store.get(SAVED_T, []) || [];
  const savedPlayers = () => store.get(SAVED_P, []) || [];
  function rememberPlayers(list) {
    const cur = savedPlayers(); const seen = new Set(cur.map((x) => x.toLowerCase()));
    list.flat().map((x) => String(x || '').trim()).filter(Boolean).forEach((n) => { if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); cur.unshift(n); } });
    store.set(SAVED_P, cur.slice(0, 80)); renderSaved();
  }
  // Saved library (teams + individual players) under the two team cards
  let libTab = 'teams';
  function renderSaved() {
    const teams = savedTeams(), plist = savedPlayers(), E = PBCommon.esc;
    $('libTn').textContent = teams.length || ''; $('libPn').textContent = plist.length || '';
    $('libTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.l === libTab));
    $('libAdd').classList.toggle('hidden', libTab !== 'players');
    const to = (kind, i) => '<span class="lib-to"><button type="button" data-to="0" data-kind="' + kind + '" data-i="' + i + '" title="Put on team A">A</button><button type="button" data-to="1" data-kind="' + kind + '" data-i="' + i + '" title="Put on team B">B</button><button type="button" class="lib-x" data-del="' + kind + '" data-i="' + i + '" aria-label="Remove">×</button></span>';
    $('libList').innerHTML = libTab === 'teams'
      ? (teams.map((x, i) => '<div class="lib-it"><i style="background:' + E(x.color || '#888') + '"></i><span class="lib-nm"><b>' + E(x.name) + '</b>' + (x.players && x.players.some(Boolean) ? '<small>' + E(x.players.filter(Boolean).join(' · ')) + '</small>' : '') + '</span>' + to('team', i) + '</div>').join('')
        || '<div class="lib-empty">No saved teams yet — type a team, then tap <b>☆ Save team</b>.</div>')
      : (plist.map((n, i) => '<div class="lib-it"><i class="pl-dot">👤</i><span class="lib-nm"><b>' + E(n) + '</b></span>' + to('player', i) + '</div>').join('')
        || '<div class="lib-empty">No saved players yet — tap <b>☆</b> in a player box, or add one below.</div>');
    const pl = new Set(); teams.forEach((x) => (x.players || []).forEach((n) => n && pl.add(n))); plist.forEach((n) => pl.add(n));
    $('savedPl').innerHTML = [...pl].map((n) => '<option value="' + E(n) + '">').join('');
  }
  function savePlayer(name, quiet) {
    name = String(name || '').trim().toUpperCase().slice(0, 16); if (!name) { flash('Type a player name first'); return false; }
    const list = savedPlayers().filter((x) => x.toLowerCase() !== name.toLowerCase()); list.unshift(name); store.set(SAVED_P, list.slice(0, 120));
    renderSaved(); if (!quiet) flash('Saved player ' + name); return true;
  }
  function putPlayer(name, t) {   // first empty slot of that team (player 2 is skipped in singles), else replace the last slot
    const L = t ? 'B' : 'A', single = !!(draft && draft.mode === 'singles');
    const slots = single ? ['p' + L + '0'] : ['p' + L + '0', 'p' + L + '1'];
    const free = slots.find((id) => !$(id).value.trim()) || slots[slots.length - 1];
    $(free).value = name; flash(name + ' → team ' + (t ? 'B' : 'A'));
  }
  function pickSaved(i, t) {
    const x = savedTeams()[i]; if (!x) return;
    const L = t ? 'B' : 'A';
    $('n' + L).value = x.name; $('p' + L + '0').value = (x.players && x.players[0]) || ''; $('p' + L + '1').value = (x.players && x.players[1]) || '';
    if (draft && draft.colors && x.color && String(x.color).toLowerCase() !== String(draft.colors[1 - t]).toLowerCase()) draft.colors[t] = x.color;
    if (draft) paintSheet(); flash(x.name + ' added');
  }
  function saveTeam(t) {
    const L = t ? 'B' : 'A';
    const name = $('n' + L).value.trim().toUpperCase(); const pls = [$('p' + L + '0').value.trim(), $('p' + L + '1').value.trim()];
    if (!name && !pls.some(Boolean)) { flash('Type a team name first'); return; }
    const entry = { name: name || pls.filter(Boolean).join(' & ').toUpperCase(), players: pls, color: draft && draft.colors ? draft.colors[t] : undefined };
    const list = savedTeams().filter((x) => x.name.toLowerCase() !== entry.name.toLowerCase());
    list.unshift(entry); store.set(SAVED_T, list.slice(0, 60));
    pls.filter(Boolean).forEach((n) => savePlayer(n, true)); libTab = 'teams'; renderSaved(); flash('Saved team ' + entry.name);
  }
  $('libTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; libTab = b.dataset.l; renderSaved(); };
  $('libList').addEventListener('click', (e) => {
    const go = e.target.closest('[data-to]'), del = e.target.closest('[data-del]');
    if (go) { const i = +go.dataset.i, t = +go.dataset.to; if (go.dataset.kind === 'team') pickSaved(i, t); else { const n = savedPlayers()[i]; if (n) putPlayer(n, t); } }
    if (del) {
      const i = +del.dataset.i;
      if (del.dataset.del === 'team') { const list = savedTeams(); const x = list[i]; if (x && confirm('Remove saved team ' + x.name + '?')) { list.splice(i, 1); store.set(SAVED_T, list); renderSaved(); } }
      else { const list = savedPlayers(); const n = list[i]; if (n && confirm('Remove saved player ' + n + '?')) { list.splice(i, 1); store.set(SAVED_P, list); renderSaved(); } }
    }
  });
  $('libAdd').onsubmit = (e) => { e.preventDefault(); if (savePlayer($('libNew').value)) $('libNew').value = ''; };
  document.querySelectorAll('.pl-sv').forEach((b) => { b.onclick = () => savePlayer($(b.dataset.p).value); });
  $('saveA').onclick = () => saveTeam(0); $('saveB').onclick = () => saveTeam(1);
  renderSaved();

  $('applyNames').onclick = () => { rememberPlayers(players()); if (send({ a: 'rename', names: names(), colors: draft.colors, players: players() })) { flash('Updated'); closeSheet(); } };
  $('ptA').onclick = () => { if (send({ a: 'partners', team: 0 })) flash('Positions swapped'); };
  $('ptB').onclick = () => { if (send({ a: 'partners', team: 1 })) flash('Positions swapped'); };
  $('newMatch').onclick = () => {
    draft.names = names(); draft.players = players(); rememberPlayers(draft.players);
    if (st && !st.matchOver && (st.score[0] + st.score[1] + st.games[0] + st.games[1]) > 0 && !confirm('Reset the current match?')) return;
    if (send({ a: 'new', settings: draft })) { flash('New match'); closeSheet(); }
  };
  $('setBtn').onclick = openSheet;
  $('sheetX').onclick = closeSheet;
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  /* ---------- Match history, stats & share cards ---------- */
  let savedKeys = new Set(store.get('aopb.savedMatches', []) || []);
  async function maybeSaveMatch() {
    if (!st || !st.matchOver || mode !== 'solo' || !PBAuth.user || !st.id || savedKeys.has(st.id)) return;
    savedKeys.add(st.id); store.set('aopb.savedMatches', [...savedKeys].slice(-200));
    const s = st.settings, stx = PBEngine.stats(st);
    const res = await PBAuth.saveMatch({ match_key: st.id, played_at: new Date(st.startedAt || Date.now()).toISOString(), mode: 'solo', names: s.names, colors: s.colors, players: s.players,
      settings: { mode: s.mode, scoring: s.scoring, target: s.target, bestOf: s.bestOf, winBy: s.winBy }, games: st.gameLog, winner: st.winner, stats: stx });
    if (res.ok) flash('Match saved to My matches'); else { savedKeys.delete(st.id); }
  }
  const fmtDate = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let histCache = [];
  async function openHist() {
    $('hist').classList.remove('hidden'); $('histDetail').classList.add('hidden'); $('histList').classList.remove('hidden'); $('histTitle').textContent = 'My matches';
    if (!PBAuth.user) { $('histList').innerHTML = '<p class="hint-sm">Sign in with Google to keep your match history.</p>'; return; }
    $('histList').innerHTML = '<p class="hint-sm">Loading…</p>';
    histCache = await PBAuth.myMatches();
    if (!histCache.length) { $('histList').innerHTML = '<p class="hint-sm">No finished matches yet. When a match ends, it is saved here automatically.</p>'; return; }
    const wins = {}; histCache.forEach((m) => { const w = m.names[m.winner]; wins[w] = (wins[w] || 0) + 1; });
    const top = Object.entries(wins).sort((a, b) => b[1] - a[1])[0];
    $('histList').innerHTML = '<div class="hist-sum"><div><b>' + histCache.length + '</b><span>matches</span></div><div><b>' + esc(top[0]) + '</b><span>most wins (' + top[1] + ')</span></div></div>' +
      histCache.map((m, i) => '<button class="hist-item" data-i="' + i + '"><span class="hi-date">' + fmtDate(m.played_at) + '</span><span class="hi-teams"><b style="color:' + esc(m.colors[m.winner]) + '">' + esc(m.names[m.winner]) + '</b> def. ' + esc(m.names[1 - m.winner]) + '</span><span class="hi-score">' + m.games.map((g) => (m.winner ? g.b + '–' + g.a : g.a + '–' + g.b)).join(', ') + '</span></button>').join('');
    $('histList').querySelectorAll('.hist-item').forEach((b) => b.onclick = () => showMatch(histCache[+b.dataset.i]));
  }
  function statRows(m) {
    const T = m.stats && m.stats.teams; if (!T) return '';
    const row = (lbl, f) => '<tr><td>' + f(0) + '</td><th>' + lbl + '</th><td>' + f(1) + '</td></tr>';
    const tags = (t) => Object.entries(T[t].tags || {}).map(([k, v]) => v + ' ' + k).join(', ') || '—';
    return '<table class="hist-stats"><thead><tr><td style="color:' + esc(m.colors[0]) + '">' + esc(m.names[0]) + '</td><th></th><td style="color:' + esc(m.colors[1]) + '">' + esc(m.names[1]) + '</td></tr></thead><tbody>' +
      row('Points', (t) => T[t].points) + row('Points on serve', (t) => T[t].servePts) + row('Rallies won', (t) => T[t].rallies) + row('Side-out %', (t) => T[t].sideoutPct + '%') + row('Longest run', (t) => T[t].run) + row('Rally reasons', tags) +
      '</tbody></table><p class="hint-sm">' + m.stats.rallies + ' rallies · about ' + m.stats.minutes + ' min</p>';
  }
  function showMatch(m) {
    $('histList').classList.add('hidden'); const d = $('histDetail'); d.classList.remove('hidden'); $('histTitle').textContent = 'Match';
    const w = m.winner, sc = m.games.map((g) => g.a + '–' + g.b).join('  ·  ');
    d.innerHTML = '<button class="mini-btn" id="histBack">‹ All matches</button><div class="hist-head"><span class="hi-date">' + fmtDate(m.played_at) + ' · ' + (m.settings.mode === 'singles' ? 'Singles' : 'Doubles') + ' · to ' + m.settings.target + '</span><b style="color:' + esc(m.colors[w]) + '">🏆 ' + esc(m.names[w]) + '</b><span>def. ' + esc(m.names[1 - w]) + '</span><div class="hi-big">' + esc(sc) + '</div></div>' + statRows(m) +
      '<div class="hist-acts"><button class="big-btn" id="histShare">Share result</button><button class="mini-btn" id="histDel">Delete</button></div>';
    $('histBack').onclick = openHist;
    $('histShare').onclick = () => shareCard(m);
    $('histDel').onclick = async () => { if (!confirm('Delete this match from your history?')) return; await PBAuth.deleteMatch(m.id); openHist(); };
  }
  // Share card: a 1080×1080 image with the result, ready for Facebook / Messenger
  async function shareCard(m) {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1080; const x = c.getContext('2d');
    const g = x.createRadialGradient(540, 380, 60, 540, 540, 760); g.addColorStop(0, '#2a0f4a'); g.addColorStop(1, '#06030f'); x.fillStyle = g; x.fillRect(0, 0, 1080, 1080);
    const logo = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = 'icons/dinkykong-logo.png'; });
    if (logo) x.drawImage(logo, 440, 50, 200, 192);
    try { await document.fonts.load('80px "Bebas Neue"'); } catch (e) {}
    const F = (sz) => sz + 'px "Bebas Neue", Impact, sans-serif';
    const fit = (txt, sz, y, maxW) => { let z = sz; x.font = F(z); while (z > 20 && x.measureText(txt).width > (maxW || 980)) { z -= 4; x.font = F(z); } x.fillText(txt, 540, y); };
    x.textAlign = 'center'; x.fillStyle = '#ffd21f'; x.font = F(52); x.fillText('MATCH RESULT', 540, 300);
    const w = m.winner;
    x.fillStyle = m.colors[w]; fit(String(m.names[w]), 120, 430);
    x.fillStyle = '#cbd2f0'; fit('DEF. ' + String(m.names[1 - w]), 56, 510);
    x.fillStyle = '#ffffff'; fit(m.games.map((g2) => (w ? g2.b + '-' + g2.a : g2.a + '-' + g2.b)).join('   '), 150, 690);
    const T = m.stats && m.stats.teams;
    if (T) { x.fillStyle = '#9fb0e0'; fit('LONGEST RUN ' + T[w].run + '  ·  SIDE-OUT ' + T[w].sideoutPct + '%  ·  ' + m.stats.rallies + ' RALLIES', 40, 790); }
    x.fillStyle = '#FFE600'; x.fillRect(0, 900, 1080, 180); x.fillStyle = '#0b0f22'; x.font = F(78); x.fillText('DINKYKONG.PRO', 540, 1000); x.font = F(34); x.fillText(fmtDate(m.played_at).toUpperCase() + '  ·  SCORED WITH DINKYKONG', 540, 1050);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'dinkykong-result.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'DinkyKong match result', text: m.names[w] + ' def. ' + m.names[1 - w] + ' · dinkykong.pro' }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dinkykong-result.png'; a.click(); flash('Result image saved');
  }
  $('histBtn').onclick = () => { closeSheet(); openHist(); };
  $('histX').onclick = () => $('hist').classList.add('hidden');
  $('hist').addEventListener('click', (e) => { if (e.target.id === 'hist') $('hist').classList.add('hidden'); });

  $('toDisplay').onclick = () => { try { localStorage.setItem('aopb.role', 'display'); } catch (e) {} store.del('aopb.remoteCode'); location.href = './?role=display'; };
  // Main menu: forget the remote role on this phone and show the lobby (no countdown)
  function toMenu() {
    try { localStorage.removeItem('aopb.role'); } catch (e) {}
    store.del('aopb.remoteCode');
    try { if (typeof stopScan === 'function') stopScan(); } catch (e) {}
    location.href = './?menu=1';
  }
  $('joinMenu').onclick = toMenu;
  $('toMenu').onclick = () => { if (st && !confirm('Go to the main menu? This phone will stop controlling the scoreboard.')) return; toMenu(); };
  $('unpair').onclick = () => {
    if (!confirm('Exit this scoreboard? It will restart and show a new QR code for the next players.')) return;
    leaveScreen(true, 'You left the scoreboard. It is restarting for the next players.');
  };

  /* ---------- QR scanner ---------- */
  let scanStream = null, scanRaf = 0, detector = null;
  function codeFromText(t) {
    try { const u = new URL(t); const c = u.searchParams.get('c'); if (c) { scanMode = u.searchParams.get('live') === '1' ? 'live' : u.searchParams.get('act') === '1' ? 'act' : 'solo'; return PBLink.normCode(c); } } catch (e) {}
    const m = String(t).toUpperCase().match(/\b[A-Z0-9]{6}\b/); return m ? m[0] : '';
  }
  async function startScan() {
    $('joinErr').textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('joinErr').textContent = 'This browser can’t open the camera. Use your camera app or type the code.'; return; }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) { $('joinErr').textContent = 'Camera blocked. Allow camera access, or type the code below.'; return; }
    const v = $('scanVideo'); v.srcObject = scanStream; await v.play().catch(() => {});
    $('scanner').classList.remove('hidden'); $('scanBtn').textContent = 'Stop scanning';
    if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
    if (!detector && typeof jsQR === 'undefined') { await loadScript(['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js', 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js']).catch(() => {}); }
    const cv = $('scanCanvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
    let busy = false;
    const tick = async () => {
      if (!scanStream) return;
      if (!busy && v.readyState >= 2) {
        busy = true;
        try {
          let text = '';
          if (detector) { const r = await detector.detect(v); if (r && r[0]) text = r[0].rawValue; }
          else if (typeof jsQR !== 'undefined') {
            const w = v.videoWidth, h = v.videoHeight, s = Math.min(1, 640 / Math.max(w, h));
            cv.width = w * s; cv.height = h * s; ctx.drawImage(v, 0, 0, cv.width, cv.height);
            const img = ctx.getImageData(0, 0, cv.width, cv.height); const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (r) text = r.data;
          }
          const c = text && codeFromText(text);
          if (c && c.length === 6) { buzz([30, 40, 30]); flash('Scoreboard found'); join(c); return; }
        } catch (e) {}
        busy = false;
      }
      scanRaf = requestAnimationFrame(tick);
    };
    scanRaf = requestAnimationFrame(tick);
  }
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
    $('scanner').classList.add('hidden'); $('scanBtn').textContent = 'Scan QR code';
  }
  $('scanBtn').onclick = () => (scanStream ? stopScan() : startScan());

  /* ---------- Boot ---------- */
  if (code && code.length === 6) { $('ctrl').classList.remove('hidden'); setStatus('connecting'); }
  Promise.allSettled([loadScript(LIBS.peer), PBAuth.init()]).then(() => {
    renderAccount();
    let switched = false; try { switched = sessionStorage.getItem('aopb.switched') === '1'; sessionStorage.removeItem('aopb.switched'); } catch (e) {}
    if (code && code.length === 6) join(code);
    else {
      showJoin();
      if (switched) {
        $('joinTitle').textContent = 'Scan again to continue';
        $('joinHint').innerHTML = 'Account switched' + (PBAuth.user && PBAuth.user.email ? ' to <b>' + esc(PBAuth.user.email) + '</b>' : '') + '. Point your camera at the scoreboard QR.';
      }
      if (wantScan || switched) startScan();
    }
  });
  renderCtrl();
  /* Install the remote as an app on this phone */
  PBCommon.installButton($('installApp'), { onHelp: (h) => { $('joinErr').textContent = h; } });
  PBCommon.installButton($('installApp2'), { onHelp: (h) => { alert(h); } });
  /* Count this phone in the lobby's "online now" status */
  PBAuth.live('p-' + device.slice(0, 12), { r: 'phone' }, () => {}).catch(() => {});
  /* Match setup: show a divider under the title once the sheet scrolls */
  (function () { const sh = document.querySelector('#sheet .sheet'); if (sh) sh.addEventListener('scroll', () => sh.classList.toggle('scrolled', sh.scrollTop > 4), { passive: true }); })();
  /* Connection checker: every few seconds make sure the screen still answers. If it goes quiet or the link drops,
     rebuild the connection by itself (auto-reconnect), and send any saved taps when it's back. */
  let lastHeard = Date.now(), relinkN = 0, relinkAt = 0;
  function heard() { lastHeard = Date.now(); relinkN = 0; }
  function relink(why) {
    if (!code || leaving || !$('join').classList.contains('hidden')) return;
    relinkAt = Date.now(); relinkN++; lastHeard = Date.now();
    try { if (link) link.destroy(); } catch (e) {}
    link = PBLink.client({ code, onState, onStatus: setStatus, onMessage: onLinkMessage });
    renderReconn();
  }
  function renderReconn() {
    const b = $('reconn'); if (!b) return;
    const down = !connected && link && downSince && Date.now() - downSince > 2500 && $('join').classList.contains('hidden') && !leaving;
    b.classList.toggle('hidden', !down);
    if (down) $('reconnTxt').textContent = (mode === 'live' ? 'Reconnecting to the court' : 'Reconnecting to the scoreboard') + (relinkN ? ' · try ' + relinkN : '') + (queue.length ? ' · ' + queue.length + ' tap' + (queue.length > 1 ? 's' : '') + ' saved' : '');
  }
  setInterval(() => {
    if (leaving || !code || !link) return;
    const now = Date.now();
    if (connected) {
      try { link.sendMsg({ t: 'rtt', at: now }); } catch (e) {}
      if (now - lastHeard > 16000) { setStatus('lost'); relink('silent'); }   // connected on paper, but the screen stopped answering
    } else if (downSince && now - downSince > 5000) {
      const wait = Math.min(20000, 4000 + relinkN * 3000);   // 4 s, 7 s, 10 s … up to 20 s between tries
      if (now - relinkAt > wait) relink('down');
    }
    renderReconn();
  }, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && code && link && !leaving) { if (!connected) relink('wake'); else { try { link.sendMsg({ t: 'rtt', at: Date.now() }); } catch (e) {} } } });
  window.addEventListener('online', () => { if (code && link && !connected && !leaving) relink('online'); });
  $('reconnNow') && ($('reconnNow').onclick = () => { flash('Reconnecting…'); relink('tap'); });
  /* Stuck connecting? After 15 s offer "Scan again" (the scoreboard may have restarted with a new code). */
  setInterval(() => {
    const show = !leaving && link && !connected && downSince && Date.now() - downSince > (mode === 'live' ? 45000 : 20000) && !$('ctrl').classList.contains('hidden');
    if (show) $('connHelpTxt').textContent = navigator.onLine === false
      ? 'This phone is offline. Check Wi-Fi or mobile data, then tap Retry.'
      : 'Scoreboard ' + code + ' isn’t answering. It may have restarted with a new code — scan its QR code again.';
    $('connHelp').classList.toggle('hidden', !show);
  }, 1000);
  $('connRetry').onclick = () => { const c = code; downSince = Date.now(); $('connHelp').classList.add('hidden'); if (link) link.destroy(); link = null; join(c); };
  $('connRescan').onclick = () => { leaveScreen(false); downSince = Date.now(); startScan(); };
  /* LIVE activation (organizer) */
  function showActDone(m) {
    const t = m.until ? new Date(m.until) : null;
    $('actUntil').textContent = t ? t.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'today';
    $('actDone').classList.remove('hidden');
    try { link && link.sendMsg({ t: 'tour?' }); } catch (e) {}
    setGate(null); $('shop').classList.add('hidden'); closeSheet();   // LIVE is on: nothing else to show on the organizer's phone
  }
  $('actDoneBtn').onclick = () => { leaveScreen(false, 'LIVE is still on. To referee a court, scan that court’s QR code.'); };
  $('actExitBtn').onclick = () => {
    if (!confirm('Exit LIVE? The LIVE screen locks, its courts are cleared and it shows a new QR code for the next organizer. Your remaining LIVE time stays on your account.')) return;
    leaveScreen(true, 'LIVE closed. Scan a QR code to continue.');   // tells the LIVE screen to lock
    buzz([40, 60, 40]);
    $('joinTitle').textContent = 'LIVE closed'; $('joinHint').textContent = 'The LIVE screen is locked and ready for the next organizer. Scan a QR code to continue.';
    startScan();
  };

  /* ---------- Club branding (LIVE pass): logo, colour and sponsor on the TV scoreboard ---------- */
  let club = Object.assign({ on: 1, name: '', logo: '', accent: '', sponsor: '', sponsorLogo: '' }, store.get('aopb.clubBrand', {}) || {});
  let clubOK = false;
  const CLUB_COLORS = ['#5B2A9C', '#0A7BFF', '#00A86B', '#E0262F', '#FF8A00', '#FFE600', '#111827'];
  $('clubSw').innerHTML = CLUB_COLORS.map((c) => '<button type="button" class="sw" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>').join('');
  function saveClub() { try { store.set('aopb.clubBrand', club); } catch (e) { flash('Image too large to keep'); } }
  function renderClub() {
    $('clubSec').classList.toggle('locked', AUTH && !clubOK);
    $('clubLock').textContent = AUTH && !clubOK
      ? 'Your club logo, colour and sponsor on the TV scoreboard. Part of the LIVE pass — also included in the 1-month free trial of a new account.'
      : 'Shows on the TV scoreboard while you are signed in. Part of your LIVE pass.';
    $('clubOn').querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(club.on ? 1 : 0) === b.dataset.v));
    $('clubLogoBox').classList.toggle('has', !!club.logo); $('clubLogoPrev').src = club.logo || '';
    $('clubSpBox').classList.toggle('has', !!club.sponsorLogo); $('clubSpPrev').src = club.sponsorLogo || '';
    if (document.activeElement !== $('clubName')) $('clubName').value = club.name || '';
    if (document.activeElement !== $('clubSponsor')) $('clubSponsor').value = club.sponsor || '';
    $('clubSw').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === club.accent));
  }
  function sendClub(quiet) {
    if (!link || !connected || mode !== 'solo') { if (!quiet) flash('Connect to a scoreboard first'); return; }
    if (AUTH && !clubOK) { if (!quiet) flash('Club branding needs a LIVE pass'); return; }
    sendClub.quiet = quiet;
    link.sendMsg({ t: 'club', brand: club });
  }
  function shrink(file, maxW, maxH) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const w0 = img.naturalWidth || maxW, h0 = img.naturalHeight || maxH, k = Math.min(1, maxW / w0, maxH / h0);
        const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
        let d = cv.toDataURL('image/webp', .88); if (!d.startsWith('data:image/webp')) d = cv.toDataURL('image/png');
        resolve(d);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad')); };
      img.src = url;
    });
  }
  function pickImg(input, key, w, h) {
    input.onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
      if (f.size > 8 * 1024 * 1024) { flash('Image too large (max 8 MB)'); return; }
      try { club[key] = await shrink(f, w, h); saveClub(); renderClub(); } catch (err) { flash('Could not read that image'); }
    };
  }
  pickImg($('clubLogoFile'), 'logo', 320, 320);
  pickImg($('clubSpFile'), 'sponsorLogo', 480, 160);
  $('clubLogoDel').onclick = () => { club.logo = ''; saveClub(); renderClub(); };
  $('clubSpDel').onclick = () => { club.sponsorLogo = ''; saveClub(); renderClub(); };
  $('clubName').oninput = () => { club.name = $('clubName').value.trim().toUpperCase(); saveClub(); };
  $('clubSponsor').oninput = () => { club.sponsor = $('clubSponsor').value.trim().toUpperCase(); saveClub(); };
  $('clubSw').querySelectorAll('button').forEach((b) => b.onclick = () => { club.accent = club.accent === b.dataset.c ? '' : b.dataset.c; saveClub(); renderClub(); });
  $('clubOn').querySelectorAll('button').forEach((b) => b.onclick = () => { club.on = b.dataset.v === '1' ? 1 : 0; saveClub(); renderClub(); sendClub(); });
  $('clubApply').onclick = () => sendClub();
  function onClubMsg(m) {
    if (m.t === 'clubok') { $('clubMsg').textContent = m.on ? 'Branding is on the scoreboard.' : 'Branding is off.'; if (!sendClub.quiet) { flash(m.on ? 'Branding updated' : 'Branding off'); buzz(20); } return true; }
    if (m.t === 'clubdenied') { clubOK = false; renderClub(); if (!sendClub.quiet) flash('Club branding needs a LIVE pass'); return true; }
    return false;
  }
  function clubAuth(m) {   // the scoreboard says whether this account's LIVE pass / trial covers branding
    clubOK = !AUTH || !!m.brand; renderClub();
    if (clubOK && club.on && (club.logo || club.name || club.sponsor || club.sponsorLogo || club.accent)) sendClub(true);
  }
  renderClub();

  /* ---------- Organizer phone: set up and start a tournament on the LIVE screen ---------- */
  const PT_INFO = {
    rr: 'Everyone plays everyone once. Most wins takes the title; ties go to point difference.',
    se: 'Lose once and you are out. Winners move up the bracket to the final.',
    de: 'Lose twice to be out. Losers-bracket winner meets the winners-bracket champion in the grand final.',
    pools: 'Pools play round robin; the top teams of each pool go on to a knockout playoff.'
  };
  const ptDraft = Object.assign({ format: 'rr', draw: 'random', courts: 2, pools: 2, advance: 2, target: 11, bestOf: 1, scoring: 'sideout', mode: 'doubles', courtChange: 0, announce: 1, name: '', teams: '' }, store.get('aopb.tourPhone', {}) || {});
  let ptState = null;
  const ptList = () => $('ptTeams').value.split('\n').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const ptEsc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ptSave() { ptDraft.name = $('ptName').value; ptDraft.teams = $('ptTeams').value; store.set('aopb.tourPhone', ptDraft); }
  function ptCountText(list) {
    const n = list.length;
    if (n < 2) return 'Add at least 2 teams.';
    const nm = list.map((x) => x.split(/\s*(?::|\s[-–]\s)/)[0].trim());
    if (nm.some((x) => !x)) return 'Each line needs a team name.';
    const dup = nm.find((x, i) => nm.indexOf(x) !== i); if (dup) return dup + ' is listed twice.';
    if (ptDraft.format === 'pools' && n < ptDraft.pools * 2) return ptDraft.pools + ' pools need at least ' + ptDraft.pools * 2 + ' teams.';
    const m = ptDraft.format === 'rr' ? n * (n - 1) / 2 : ptDraft.format === 'se' ? n - 1 : ptDraft.format === 'de' ? (2 * n - 2) + '–' + (2 * n - 1) : null;
    return n + ' teams' + (m != null ? ' · ' + m + ' matches' : '') + ' · ' + ptDraft.courts + ' court' + (ptDraft.courts > 1 ? 's' : '') + (ptDraft.courts === 1 ? ' · voice calls on' : '');
  }
  function ptRenderSetup() {
    document.querySelectorAll('.pt-seg').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(ptDraft[seg.dataset.tk]) === b.dataset.v)));
    document.querySelectorAll('.pt-sel').forEach((el) => { el.value = String(ptDraft[el.dataset.tk]); });
    $('ptPoolRow2').classList.toggle('hidden', ptDraft.format !== 'pools');
    $('ptPoolRow').classList.toggle('hidden', ptDraft.format !== 'pools');
    $('ptFmtInfo').textContent = PT_INFO[ptDraft.format] || '';
    const list = ptList(), txt = ptCountText(list);
    $('ptCount').textContent = txt; $('ptCount').classList.toggle('bad', !/teams ·/.test(txt));
    $('ptStart').disabled = !/teams ·/.test(txt);
    const have = new Set(list.map((x) => x.split(/\s*(?::|\s[-–]\s)/)[0].trim()));
    $('ptSaved').innerHTML = savedTeams().filter((x) => !have.has(String(x.name).toUpperCase())).slice(0, 16)
      .map((x) => { const pl = (x.players || []).filter(Boolean); const line = String(x.name).toUpperCase() + (pl.length ? ': ' + pl.join(', ').toUpperCase() : ''); return '<button class="pt-chip" data-n="' + ptEsc(line) + '">+ ' + ptEsc(x.name) + '</button>'; }).join('');
  }
  document.querySelectorAll('.pt-sel').forEach((el) => el.onchange = () => { ptDraft[el.dataset.tk] = /^\d+$/.test(el.value) ? Number(el.value) : el.value; ptSave(); ptRenderSetup(); buzz(10); });
  document.querySelectorAll('.pt-seg').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.onclick = () => {
    ptDraft[seg.dataset.tk] = /^\d+$/.test(b.dataset.v) ? Number(b.dataset.v) : b.dataset.v; ptSave(); ptRenderSetup(); buzz(10);
  }));
  $('ptName').value = ptDraft.name || ''; $('ptTeams').value = ptDraft.teams || '';
  $('ptName').oninput = ptSave;
  $('ptTeams').oninput = () => { ptSave(); ptRenderSetup(); };
  $('ptSaved').onclick = (e) => {
    const b = e.target.closest('.pt-chip'); if (!b) return;
    const v = $('ptTeams').value.replace(/\s+$/, ''); $('ptTeams').value = (v ? v + '\n' : '') + b.dataset.n; ptSave(); ptRenderSetup(); buzz(10);
  };
  $('ptStart').onclick = () => {
    if (!link || !connected) { flash('Not connected to the LIVE screen'); return; }
    const list = ptList(); if (!/teams ·/.test(ptCountText(list))) return;
    if (!confirm('Start ' + (ptDraft.name.trim() || 'the tournament') + ' with ' + list.length + ' teams on ' + ptDraft.courts + ' court' + (ptDraft.courts > 1 ? 's' : '') + '? The first matches load on the free courts right away.')) return;
    $('ptErr').textContent = '';
    link.sendMsg({ t: 'tourStart', opts: Object.assign({}, ptDraft, { teams: list }) });
    $('ptStart').disabled = true; $('ptStart').textContent = 'Starting…';
    setTimeout(() => { $('ptStart').textContent = 'Start & deploy teams'; ptRenderSetup(); }, 2500);
  };
  $('ptEnd').onclick = () => {
    if (!link || !connected || !ptState || !ptState.tour) return;
    if (!ptState.tour.champ && !confirm('Set up a new tournament? ' + ptState.tour.name + '’s results are cleared; your team list stays.')) return;
    link.sendMsg({ t: 'tourEnd' });
  };
  $('ptRestart').onclick = () => {
    if (!link || !connected || !ptState || !ptState.tour) return;
    if (!confirm('Restart ' + ptState.tour.name + ' from the first match? All results are cleared; teams and settings stay the same.')) return;
    link.sendMsg({ t: 'tourRestart' }); flash('Restarting…');
  };
  function ptRender() {
    const t = ptState && ptState.tour;
    $('ptSetup').classList.toggle('hidden', !!t); $('ptRun').classList.toggle('hidden', !t);
    if (!t) { $('ptSt').textContent = 'Not started'; if (ptState && ptState.courts && !store.get('aopb.tourPhone', null)) ptDraft.courts = ptState.courts; ptRenderSetup(); return; }
    $('ptSt').textContent = t.name + ' · ' + t.done + '/' + t.total;
    $('ptChamp').classList.toggle('hidden', !t.champ);
    $('ptChamp').innerHTML = t.champ ? '<small>Champion</small><b>' + ptEsc(t.champ) + '</b>' : '';
    $('ptUp').innerHTML = (t.up || []).length ? '<span class="eyebrow">On court · up next</span>' + t.up.map((u) => '<div class="pt-m"><span class="' + (u[0] === 'NEXT' ? 'nx' : '') + '">' + ptEsc(u[0]) + '</span><b>' + ptEsc(u[1]) + ' <i>vs</i> ' + ptEsc(u[2]) + '</b></div>').join('') : '';
    const tab = (rows) => '<table class="pt-tab"><tr><th>Team</th><th>W</th><th>L</th><th>+/-</th></tr>' + rows.map((r) => '<tr><td>' + ptEsc(r[0]) + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + (r[3] > 0 ? '+' : '') + r[3] + '</td></tr>').join('') + '</table>';
    $('ptTable').innerHTML = t.rows ? '<span class="eyebrow">Standings</span>' + tab(t.rows) : t.pools ? t.pools.map((p, i) => '<span class="eyebrow">Pool ' + String.fromCharCode(65 + i) + '</span>' + tab(p)).join('') : '';
  }
  function onTourMsg(m) {
    if (m.t === 'tourState') { const was = ptState && ptState.tour; ptState = m; ptRender(); if (!was && m.tour) { flash('Tournament started'); buzz([30, 40, 30]); } return true; }
    if (m.t === 'tourErr') { $('ptErr').textContent = m.reason || 'Could not start the tournament.'; $('ptStart').textContent = 'Start & deploy teams'; ptRenderSetup(); buzz([60, 40, 60]); return true; }
    return false;
  }
  ptRenderSetup();

  /* ---------- New match: ask for both teams (left side first, as seen facing the scoreboard) ---------- */
  const tw = { step: 0, kind: 'new', base: null, teams: [null, null], left: 0 };
  const isDefTeam = (n) => !n || /^TEAM [AB]$/i.test(String(n).trim());
  function openTeamWiz(kind) {
    if (!st || mode !== 'solo') return;
    tw.kind = kind; tw.base = JSON.parse(JSON.stringify(st.settings));
    tw.left = kind === 'rename' && st.swapped ? 1 : 0;   // a new match starts unswapped: team 1 is on the left
    const s = tw.base, pl = s.players || [[], []];
    tw.teams = [0, 1].map((side) => { const t = side === 0 ? tw.left : 1 - tw.left; return { name: isDefTeam(s.names[t]) ? '' : s.names[t], p: [(pl[t] || [])[0] || '', (pl[t] || [])[1] || ''], color: s.colors[t] }; });
    tw.step = 0; twPaint(); $('teamWiz').classList.remove('hidden'); buzz(15);
    setTimeout(() => { try { $('twName').focus(); $('twName').select(); } catch (e) {} }, 120);
  }
  function twRead() { const t = tw.teams[tw.step]; t.name = $('twName').value.trim().toUpperCase(); t.p = [$('twP1').value.trim(), $('twP2').value.trim()]; }
  function twPaint() {
    const i = tw.step, t = tw.teams[i], other = tw.teams[1 - i], singles = tw.base.mode === 'singles';
    $('twStep').textContent = 'TEAM ' + (i + 1) + ' OF 2';
    $('twTitle').textContent = i ? 'SECOND TEAM' : 'FIRST TEAM';
    $('twSide').textContent = (i ? 'Right' : 'Left') + ' side of the court, facing the scoreboard';
    $('twHalfL').setAttribute('fill-opacity', i ? '0' : '.85'); $('twHalfR').setAttribute('fill-opacity', i ? '.85' : '0');
    $('twName').value = t.name; $('twP1').value = t.p[0]; $('twP2').value = t.p[1];
    $('twP2w').classList.toggle('hidden', singles); $('twP1').previousElementSibling.textContent = singles ? 'Player' : 'Player 1';
    $('twSw').innerHTML = PALETTE.slice(0, 6).map((c) => { const taken = i === 1 && c.toLowerCase() === String(other.color).toLowerCase(); return '<button type="button" class="sw' + (c.toLowerCase() === String(t.color).toLowerCase() ? ' on' : '') + (taken ? ' taken' : '') + '" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + (taken ? ' (first team)' : '') + '"' + (taken ? ' disabled' : '') + '></button>'; }).join('');
    $('twSw').querySelectorAll('.sw').forEach((b) => b.onclick = () => { if (b.disabled) return; twRead(); t.color = b.dataset.c; twPaint(); buzz(8); });
    const used = new Set([other.name].filter(Boolean).map((x) => x.toLowerCase()));
    $('twSaved').innerHTML = savedTeams().filter((x) => !used.has(String(x.name).toLowerCase())).slice(0, 10).map((x, k) => '<button type="button" class="tw-chip" data-k="' + k + '"><i style="background:' + esc(x.color || '#888') + '"></i>' + esc(x.name) + '</button>').join('');
    $('twSaved').querySelectorAll('.tw-chip').forEach((b) => b.onclick = () => {
      const x = savedTeams().filter((y) => !used.has(String(y.name).toLowerCase()))[+b.dataset.k]; if (!x) return;
      t.name = x.name; t.p = [(x.players || [])[0] || '', (x.players || [])[1] || ''];
      if (x.color && !(i === 1 && x.color.toLowerCase() === String(other.color).toLowerCase())) t.color = x.color;
      twPaint(); buzz(10);
    });
    $('twBack').textContent = i ? '← Back' : 'Skip';
    $('twNext').textContent = i ? 'Start match' : 'Next: second team →';
  }
  function twFinish() {
    const [L, R] = tw.teams, left = tw.left;
    const byTeam = left === 0 ? [L, R] : [R, L];
    const names = byTeam.map((t, k) => t.name || (t.p.filter(Boolean).join(' & ').toUpperCase().slice(0, 18)) || (k ? 'TEAM B' : 'TEAM A'));
    const players = byTeam.map((t) => [t.p[0], tw.base.mode === 'singles' ? '' : t.p[1]]);
    let colors = byTeam.map((t) => t.color);
    if (String(colors[0]).toLowerCase() === String(colors[1]).toLowerCase()) colors[1] = PALETTE.find((c) => c.toLowerCase() !== String(colors[0]).toLowerCase());
    // remember named teams on this phone for next time
    byTeam.forEach((t, k) => { if (!t.name) return; const list = savedTeams().filter((x) => x.name.toLowerCase() !== names[k].toLowerCase()); list.unshift({ name: names[k], players: players[k], color: colors[k] }); store.set(SAVED_T, list.slice(0, 40)); });
    rememberPlayers(players);
    const ok = tw.kind === 'new' ? send({ a: 'new', settings: Object.assign({}, tw.base, { names, players, colors }) }) : send({ a: 'rename', names, colors, players });
    if (ok) { $('teamWiz').classList.add('hidden'); flash(tw.kind === 'new' ? 'New match · ' + names[0] + ' vs ' + names[1] : names[0] + ' vs ' + names[1]); buzz(30); }
  }
  $('twNext').onclick = () => { twRead(); if (tw.step === 0) { tw.step = 1; twPaint(); setTimeout(() => { try { $('twName').focus(); } catch (e) {} }, 80); } else twFinish(); };
  $('twBack').onclick = () => {
    twRead();
    if (tw.step === 1) { tw.step = 0; twPaint(); return; }
    // Skip: keep the teams as they are
    $('teamWiz').classList.add('hidden');
    if (tw.kind === 'new' && send({ a: 'new', settings: tw.base })) flash('New match');
  };
  $('twClose').onclick = () => $('teamWiz').classList.add('hidden');
  $('twOpen').onclick = () => { closeSheet(); openTeamWiz('rename'); };
  ['twName', 'twP1', 'twP2'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const nx = { twName: 'twP1', twP1: tw.base && tw.base.mode === 'singles' ? null : 'twP2', twP2: null }[id]; if (nx) $(nx).focus(); else $('twNext').click(); } }));
  // A fresh match with default names on this screen: ask once for the teams
  const twAsked = new Set();
  function maybeAskTeams() {
    if (!st || mode !== 'solo' || !authed || !connected || st.matchOver || twAsked.has(st.id)) return;
    const fresh = st.score[0] + st.score[1] === 0 && st.games[0] + st.games[1] === 0 && st.gameNo === 1 && !st.playForServe;
    if (!fresh || !isDefTeam(st.settings.names[0]) || !isDefTeam(st.settings.names[1])) return;
    if (!$('teamWiz').classList.contains('hidden') || !$('sheet').classList.contains('hidden')) return;
    twAsked.add(st.id); openTeamWiz('rename');
  }
  setInterval(maybeAskTeams, 1500);
  $('refTourRestart').onclick = () => {
    if (!link || !connected) { flash('Not connected to the court'); return; }
    if (!confirm('Restart the tournament from the first match?\n\nAll results and standings are cleared. Teams, format and rules stay the same.')) return;
    link.sendMsg({ t: 'tourRestart' }); buzz([60, 40, 60]); flash('Restarting tournament…'); closeSheet();
  };
  setMode(mode);
})();

/* Device bar: long-press shows the label without running the button */
(function () {
  const bar = document.querySelector('#sheet .dev-bar .sheet-actions'); if (!bar) return;
  let timer = 0, shown = null, hideT = 0;
  const clear = () => { clearTimeout(timer); timer = 0; };
  const hide = () => { if (shown) shown.classList.remove('tip'); shown = null; };
  bar.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.act-btn'); if (!b || e.pointerType === 'mouse') return;
    clear(); bar._held = false;
    timer = setTimeout(() => { hide(); bar._held = true; shown = b; b.classList.add('tip'); try { navigator.vibrate && navigator.vibrate(15); } catch (_) {} clearTimeout(hideT); hideT = setTimeout(hide, 1600); }, 450);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => bar.addEventListener(ev, clear));
  bar.addEventListener('click', (e) => { if (bar._held) { bar._held = false; e.preventDefault(); e.stopPropagation(); } }, true);
  bar.addEventListener('contextmenu', (e) => e.preventDefault());
})();
