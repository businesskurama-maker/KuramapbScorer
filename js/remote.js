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
  let code = PBLink.normCode(params.get('c') || (wantScan ? '' : store.get('aopb.remoteCode', '')));
  // 'solo' = normal scoreboard · 'live' = a court on a LIVE screen (referee, no sign-in) · 'act' = organizer activating LIVE
  let mode = params.get('live') === '1' ? 'live' : params.get('act') === '1' ? 'act'
    : (code && code === store.get('aopb.remoteCode', '') ? store.get('aopb.remoteMode', 'solo') : 'solo');
  let scanMode = null;
  function setMode(m) {
    mode = m; store.set('aopb.remoteMode', m);
    document.body.classList.toggle('mode-live', m === 'live'); document.body.classList.toggle('mode-act', m === 'act');
    if (m === 'live') authed = true;
  }
  const modeQS = () => (mode === 'live' ? '&live=1' : mode === 'act' ? '&act=1' : '');
  try { localStorage.setItem('aopb.role', 'remote'); } catch (e) {}
  const touch = () => { try { localStorage.setItem('aopb.remoteAt', String(Date.now())); } catch (e) {} };

  function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms || 18); } catch (e) {} }
  let flashT;
  function flash(t) { const f = $('flash'); f.textContent = t; f.classList.add('show'); clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 1400); }

  /* ---------- Status ---------- */
  let downSince = Date.now(), wasLive = false, kickT = null;
  function setStatus(s) {
    if (leaving) return;
    // LIVE court: if the referee loses the court, they must scan the QR or enter the code again
    if (mode === 'live') {
      if (s === 'connected') { wasLive = true; clearTimeout(kickT); kickT = null; }
      else if (wasLive && !kickT) kickT = setTimeout(() => { kickT = null; if (!connected && mode === 'live') { wasLive = false; leaveScreen(false, 'Connection to the court was lost. Scan the court’s QR code or enter its code again.'); buzz([80, 60, 80]); } }, 8000);
    }
    if (s === 'connected') { downSince = 0; $('connHelp').classList.add('hidden'); }
    else if (!downSince) downSince = Date.now();
    if (s === 'connected' && !connected) setTimeout(sendAuth, 50);
    const el = $('status'), txt = $('statusTxt');
    el.classList.remove('ok', 'bad');
    connected = s === 'connected';
    const labels = { connected: 'Live · ' + code, connecting: 'Connecting…', lost: 'Reconnecting…', nodisplay: 'Screen not found', nolib: 'Offline' };
    txt.textContent = labels[s] || s;
    if (s === 'connected') el.classList.add('ok');
    if (s === 'nodisplay' || s === 'nolib') el.classList.add('bad');
    renderCtrl();
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
    if (mode === 'live') { store.del('aopb.remoteCode'); history.replaceState(null, '', 'remote.html'); }   // LIVE referees always re-enter the code / rescan
    $('join').classList.add('hidden'); $('ctrl').classList.remove('hidden');
    if (link) link.destroy();
    link = PBLink.client({ code, onState, onStatus: setStatus, onMessage: onLinkMessage });
    keepAwake();
  }
  $('joinBtn').onclick = () => join($('codeIn').value);
  $('codeIn').addEventListener('input', (e) => { e.target.value = PBLink.normCode(e.target.value); });
  $('codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(e.target.value); });
  $('status').onclick = () => { if (!connected && code) { flash('Retrying…'); if (link) link.destroy(); join(code); } };

  /* ---------- State from display ---------- */
  function onState(s) {
    if (leaving) return;
    if (s && s.liveCourt && mode !== 'live') { setMode('live'); setGate(null); store.del('aopb.remoteCode'); history.replaceState(null, '', 'remote.html'); }
    if (s && s.liveAct && mode !== 'act') setMode('act');
    touch();
    const prevEv = st && st.lastEvent ? st.lastEvent.t : 0;
    st = s;
    renderCtrl();
    if (s.lastEvent && s.lastEvent.t !== prevEv && prevEv) {
      const names = s.settings.names;
      const m = { partners: 'Positions fixed', sideout: 'Side out → ' + names[s.serving], second: '2nd server', game: 'Game → ' + names[s.lastEvent.team], match: 'Match → ' + names[s.lastEvent.team], swap: s.lastEvent.auto ? 'Switch ends!' : 'Sides swapped' };
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
    $('gateGoogle').classList.toggle('hidden', state !== 'signin');
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
    if (state === 'signin') { $('gateTitle').textContent = 'Sign in to start scoring'; $('gateBody').textContent = 'Continue with Google, then support the DinkyKong fund — a PHP 50 donation unlocks 24 hours.'; }
    if (state === 'checking') { $('gateTitle').textContent = 'Checking your pass…'; $('gateBody').textContent = 'One moment.'; }
    if (state === 'denied') {
      const who = opts.email || (p && p.email) || 'This account';
      $('gateTitle').textContent = locked ? 'Locked to another phone' : 'Support DinkyKong to start';
      $('gateBody').textContent = locked
        ? who + ' is already used on another phone. Passes work on one account and one phone only. Ask the owner to reset the phone lock if you changed phones.'
        : 'Signed in as ' + who + '. Pick a donation to the support fund, send it with InstaPay, and your scoring time unlocks once the developer confirms it.';
      if (opts.reason === 'OTHER_DEVICE') $('gateBody').textContent += ' Email dinkykongsupport@gmail.com.';
      if (liveEnded) { $('gateTitle').textContent = 'LIVE pass ended'; $('gateBody').textContent = 'The organizer’s LIVE pass for this screen has ended. Ask them to renew it on the LIVE screen, then tap Try again.'; }
      else if (shopKind === 'live' && !locked) { $('gateTitle').textContent = 'Get a LIVE pass'; $('gateBody').textContent = 'Signed in as ' + who + '. Pick how long you need LIVE — from PHP 20 per hour. It unlocks up to 6 courts on one screen, a referee remote for every court and the OBS lower third.'; }
    }
    if (state === 'signin' && mode === 'act') { $('gateTitle').textContent = 'Organizer sign-in'; $('gateBody').textContent = 'Sign in with Google to activate LIVE on this screen. A LIVE pass (from PHP 20 / hour) covers every court and the OBS lower third.'; }
    renderCtrl();
  }

  async function sendAuth(force) {
    if (!AUTH || !link || !connected) return;
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
    if (leaving) return;
    if (m.t === 'authok' && m.silent) { authed = true; return; }
    if (m.t === 'authok' && mode === 'act') { authRetries = 0; authed = true; setGate(null); showActDone(m); buzz([40, 60, 40]); return; }
    if (m.t === 'authok' && mode === 'live') { authed = true; setGate(null); return; }
    if (m.t === 'authok') { authRetries = 0; authed = true; setGate(null); PBAuth.refresh(); if (m.until) flash('Pass until ' + new Date(m.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); buzz([30, 40, 30]); }
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
    store.del('aopb.remoteCode'); store.del('aopb.remoteMode'); code = ''; setMode('solo'); $('actDone').classList.add('hidden');
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
  $('gateRetry').onclick = async () => { await PBAuth.refresh(); if (mode === 'live' && link) { link.sendMsg({ t: 'auth', device }); return; } sendAuth(true); };
  // Switch to another Google account (e.g. the one that donated). Google's account picker opens.
  const switchAccount = async () => {
    if (!confirm('Switch to another Google account? You’ll sign out of ' + ((PBAuth.user && PBAuth.user.email) || 'this account') + ' and pick a different one.')) return;
    flash('Switching account…');
    try { sessionStorage.setItem('aopb.switched', '1'); } catch (e) {}
    leaveScreen(false);                       // disconnect from this scoreboard (it stays on its QR page)
    try { await PBAuth.signOut(); } catch (e) {}
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
    pill.textContent = !p ? 'Loading…' : until ? 'Pass until ' + fmtUntil(until) : (p.hours_balance ? p.hours_balance + ' h ready to use' : 'No scoring time');
    const av = (p && p.avatar_url) || (u.user_metadata && u.user_metadata.avatar_url);
    if (av) $('accAvatar').src = av;
  }
  PBAuth.onChange(renderAccount);

  function send(action) {
    if (!authed) { if (AUTH) sendAuth(true); flash(PBAuth.user ? 'Waiting for approval' : 'Sign in first'); return false; }
    if (!link || !link.send(action)) { flash('Not connected'); buzz([20, 40, 20]); return false; }
    buzz(); return true;
  }

  function outcome(team) {
    if (!st) return '';
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
      el.querySelector('.n span').textContent = s.names[t] + (st.serving === t && !st.matchOver ? ' •' : '');
      el.querySelector('.n i').style.background = s.colors[t];
      el.querySelector('.s').innerHTML = seg(st.score[t], 2);
      el.querySelector('.s').style.color = s.colors[t];
      el.querySelector('.g').textContent = s.bestOf > 1 ? 'GAMES ' + st.games[t] : '';
    });
    $('call').innerHTML = seg(st.call);
    $('callX').textContent = (st.hasPlayers ? st.serverName + ' · ' : (s.bestOf > 1 ? 'Game ' + st.gameNo + ' · ' : '')) + 'serve ' + st.serveSide.toLowerCase();

    [[$('rL'), left], [$('rR'), right]].forEach(([b, t]) => {
      b.style.setProperty('--c', s.colors[t]);
      b.dataset.team = t;
      b.querySelector('.nm').textContent = s.names[t];
      b.querySelector('.what').textContent = outcome(t);
      b.querySelector('.who').innerHTML = st.hasPlayers ? st.court[t].map((p) => p.serving ? '<b>● ' + esc(p.name) + '</b>' : esc(p.name)).join('<br>') : '';
      b.disabled = !connected || st.gameOver || st.matchOver;
      b.classList.toggle('is-serving', st.serving === t && !st.matchOver);
    });

    const over = st.gameOver || st.matchOver;
    const gated = !!gateState;
    $('rallyBtns').classList.toggle('hidden', over || gated);
    $('nextBtn').classList.toggle('hidden', !over || gated);
    if (st.matchOver) $('nextBtn').innerHTML = esc(s.names[st.winner]) + ' WINS!<small>Tap to set up a new match</small>';
    else if (st.gameOver) $('nextBtn').innerHTML = 'START GAME ' + (st.gameNo + 1) + '<small>' + esc(s.names[st.gameLog[st.gameLog.length - 1].winner]) + ' took game ' + st.gameNo + '</small>';

    $('undoBtn').disabled = !connected || !st.canUndo || !authed;
    $('swapBtn').disabled = !connected || !authed;
    $('serveBtn').disabled = !connected || st.score[0] + st.score[1] > 0 || over || !authed;
    $('setBtn').disabled = !connected || (!authed && !PBAuth.user);
  }

  /* ---------- Controls ---------- */
  ['rL', 'rR'].forEach((id) => {
    const b = $(id);
    b.addEventListener('click', () => { if (!b.disabled) send({ a: 'rally', team: Number(b.dataset.team) }); });
  });
  $('undoBtn').onclick = () => send({ a: 'undo' });
  $('swapBtn').onclick = () => send({ a: 'swap' });
  $('serveBtn').onclick = () => { if (st) send({ a: 'server', team: 1 - st.serving }); };
  $('nextBtn').onclick = () => { if (!st) return; if (st.matchOver) openSheet(); else send({ a: 'next' }); };

  /* ---------- Settings sheet ---------- */
  function swatches(el, team) {
    el.innerHTML = PALETTE.slice(0, 6).map((c) => '<button class="sw" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>').join('');
    el.querySelectorAll('.sw').forEach((b) => b.onclick = () => {
      if (b.dataset.c.toLowerCase() === String(draft.colors[1 - team]).toLowerCase()) { flash((team ? 'Team A' : 'Team B') + ' already uses this color'); return; }
      draft.colors[team] = b.dataset.c; paintSheet();
    });
  }
  function paintSheet() {
    document.querySelectorAll('.seg').forEach((seg) => {
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
  }
  function openSheet() {
    const base = st ? st.settings : PBEngine.DEFAULT_SETTINGS;
    draft = JSON.parse(JSON.stringify(base));
    $('nA').value = draft.names[0]; $('nB').value = draft.names[1];
    const pls = (draft.players || [['', ''], ['', '']]);
    $('pA0').value = pls[0][0] || ''; $('pA1').value = pls[0][1] || ''; $('pB0').value = pls[1][0] || ''; $('pB1').value = pls[1][1] || '';
    swatches($('swA'), 0); swatches($('swB'), 1);
    paintSheet();
    $('sheet').classList.remove('hidden');
  }
  function closeSheet() { $('sheet').classList.add('hidden'); }
  document.querySelectorAll('.seg').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.onclick = () => {
    const k = seg.dataset.k; const v = b.dataset.v;
    draft[k] = /^\d+$/.test(v) ? Number(v) : v; paintSheet();
  }));
  ['nA', 'nB'].forEach((id) => $(id).addEventListener('input', paintSheet));
  function names() { return [$('nA').value.trim().toUpperCase() || 'TEAM A', $('nB').value.trim().toUpperCase() || 'TEAM B']; }
  function players() { return [[$('pA0').value.trim(), $('pA1').value.trim()], [$('pB0').value.trim(), $('pB1').value.trim()]]; }
  $('applyNames').onclick = () => { if (send({ a: 'rename', names: names(), colors: draft.colors, players: players() })) { flash('Updated'); closeSheet(); } };
  $('ptA').onclick = () => { if (send({ a: 'partners', team: 0 })) flash('Positions swapped'); };
  $('ptB').onclick = () => { if (send({ a: 'partners', team: 1 })) flash('Positions swapped'); };
  $('newMatch').onclick = () => {
    draft.names = names(); draft.players = players();
    if (st && !st.matchOver && (st.score[0] + st.score[1] + st.games[0] + st.games[1]) > 0 && !confirm('Reset the current match?')) return;
    if (send({ a: 'new', settings: draft })) { flash('New match'); closeSheet(); }
  };
  $('setBtn').onclick = openSheet;
  $('sheetX').onclick = closeSheet;
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('toDisplay').onclick = () => { try { localStorage.setItem('aopb.role', 'display'); } catch (e) {} store.del('aopb.remoteCode'); location.href = './?role=display'; };
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
  /* Stuck connecting? After 15 s offer "Scan again" (the scoreboard may have restarted with a new code). */
  setInterval(() => {
    const show = !leaving && link && !connected && downSince && Date.now() - downSince > 15000 && !$('ctrl').classList.contains('hidden');
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
  }
  $('actDoneBtn').onclick = () => { leaveScreen(false, 'LIVE is still on. To referee a court, scan that court’s QR code.'); };
  $('actExitBtn').onclick = () => {
    if (!confirm('Exit LIVE? The LIVE screen locks, its courts are cleared and it shows a new QR code for the next organizer. Your remaining LIVE time stays on your account.')) return;
    leaveScreen(true, 'LIVE closed. Scan a QR code to continue.');   // tells the LIVE screen to lock
    buzz([40, 60, 40]);
    $('joinTitle').textContent = 'LIVE closed'; $('joinHint').textContent = 'The LIVE screen is locked and ready for the next organizer. Scan a QR code to continue.';
    startScan();
  };
  setMode(mode);
})();
