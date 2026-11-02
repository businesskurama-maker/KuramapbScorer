(function () {
  const { seg, store, ICON, keepAwake, registerSW, loadScript, LIBS, PALETTE, esc } = PBCommon;
  const $ = (id) => document.getElementById(id);
  registerSW();

  $('iUndo').innerHTML = ICON.undo; $('iSwap').innerHTML = ICON.swap; $('iServe').innerHTML = ICON.serve; $('iGear').innerHTML = ICON.gear;

  let st = null;        // last state from display
  let link = null;
  let connected = false;
  let draft = null;     // settings being edited in the sheet
  const AUTH = PBAuth.enabled;
  let authed = !AUTH;   // TV has accepted this phone's sign-in
  let gateState = null; // 'signin' | 'checking' | 'denied' | null
  let lastAuthSend = 0;

  const params = new URLSearchParams(location.search);
  let code = PBLink.normCode(params.get('c') || store.get('aopb.remoteCode', ''));

  function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms || 18); } catch (e) {} }
  let flashT;
  function flash(t) { const f = $('flash'); f.textContent = t; f.classList.add('show'); clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 1400); }

  /* ---------- Status ---------- */
  function setStatus(s) {
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
    code = PBLink.normCode(c);
    if (code.length !== 6) { $('joinErr').textContent = 'Codes are 6 characters.'; return; }
    store.set('aopb.remoteCode', code);
    history.replaceState(null, '', 'remote.html?c=' + code);
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
    g.classList.toggle('bad', state === 'denied');
    $('gateGoogle').classList.toggle('hidden', state !== 'signin');
    $('gateRetry').classList.toggle('hidden', state !== 'denied');
    $('gateSwitch').classList.toggle('hidden', state !== 'denied');
    const p = PBAuth.profile;
    if (state === 'signin') { $('gateTitle').textContent = 'Sign in to start scoring'; $('gateBody').textContent = 'Continue with Google. Each sign-in starts a 24-hour pass that uses 1 credit, so buy credits first.'; }
    if (state === 'checking') { $('gateTitle').textContent = 'Checking credits…'; $('gateBody').textContent = 'The scoreboard is verifying your account.'; }
    if (state === 'denied') {
      $('gateTitle').textContent = opts.reason === 'NO_CREDITS' ? 'No credits' : 'Access denied';
      $('gateBody').textContent = opts.reason === 'NO_CREDITS'
        ? (opts.email || (p && p.email) || 'This account') + ' has no credits. Buy credits from Kurama, then tap Try again.'
        : 'The scoreboard could not verify your account. Check your internet and try again.';
    }
    renderCtrl();
  }

  async function sendAuth(force) {
    if (!AUTH || !link || !connected) return;
    if (!PBAuth.user) { authed = false; setGate('signin'); return; }
    if (!force && Date.now() - lastAuthSend < 4000) return;
    lastAuthSend = Date.now();
    const token = await PBAuth.accessToken();
    if (!token) { setGate('signin'); return; }
    setGate('checking');
    link.sendMsg({ t: 'auth', token });
  }

  function onLinkMessage(m) {
    if (m.t === 'authok') { authed = true; setGate(null); PBAuth.refresh(); if (m.until) flash('Pass until ' + new Date(m.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); buzz([30, 40, 30]); }
    else if (m.t === 'denied') { authed = false; setGate('denied', m); buzz([80, 60, 80]); }
    else if (m.t === 'reauth' || m.t === 'needauth') { authed = false; sendAuth(); }
  }

  $('gateGoogle').onclick = () => PBAuth.signIn();
  $('gateRetry').onclick = async () => { await PBAuth.refresh(); sendAuth(true); };
  $('gateSwitch').onclick = async () => { await PBAuth.signOut(); PBAuth.signIn(); };
  $('accOut').onclick = async () => { closeSheet(); await PBAuth.signOut(); authed = false; setGate('signin'); };

  function renderAccount() {
    const p = PBAuth.profile, u = PBAuth.user;
    $('account').classList.toggle('hidden', !AUTH || !u);
    if (!u) return;
    $('accName').textContent = (p && p.full_name) || u.email;
    const pass = PBAuth.passActive() ? ' · pass until ' + PBAuth.passUntil().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    $('accInfo').textContent = (p ? p.credits + (p.credits === 1 ? ' credit' : ' credits') : '…') + pass;
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
    el.querySelectorAll('.sw').forEach((b) => b.onclick = () => { draft.colors[team] = b.dataset.c; paintSheet(); });
  }
  function paintSheet() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const k = seg.dataset.k;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(draft[k]) === b.dataset.v));
    });
    [['swA', 0], ['swB', 1]].forEach(([id, t]) => $(id).querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === String(draft.colors[t]).toLowerCase())));
    $('fs0').textContent = ($('nA').value || 'Team A').slice(0, 10);
    $('fs1').textContent = ($('nB').value || 'Team B').slice(0, 10);
    const single = draft.mode === 'singles';
    document.querySelectorAll('.pl2, .dbl-only').forEach((el) => el.classList.toggle('hidden', single));
    document.querySelectorAll('.player-row').forEach((el) => el.classList.toggle('single', single));
    $('pA0').placeholder = $('pB0').placeholder = single ? 'Player name' : 'Player 1 (starts right)';
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
  $('unpair').onclick = () => { closeSheet(); if (link) link.destroy(); link = null; st = null; store.del('aopb.remoteCode'); code = ''; history.replaceState(null, '', 'remote.html'); showJoin(); };

  /* ---------- Boot ---------- */
  if (code && code.length === 6) { $('ctrl').classList.remove('hidden'); setStatus('connecting'); }
  Promise.allSettled([loadScript(LIBS.peer), PBAuth.init()]).then(() => {
    renderAccount();
    if (code && code.length === 6) join(code); else showJoin();
  });
  renderCtrl();
})();
