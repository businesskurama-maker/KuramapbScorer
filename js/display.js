(function () {
  const { seg, store, ICON, keepAwake, registerSW, loadScript, LIBS, esc } = PBCommon;
  const E = PBEngine;
  const $ = (id) => document.getElementById(id);

  registerSW();

  /* ---------- State ---------- */
  let state = store.get('aopb.state', null);
  if (!state || state.v !== 1) state = E.newMatch();
  state = E.ensure(state);

  let code = store.get('aopb.code', null);
  if (!code) { code = PBLink.makeCode(); store.set('aopb.code', code); }
  const remoteUrl = () => new URL('remote.html?c=' + code, location.href).href;

  let link = null;
  let lastEventT = state.lastEvent ? state.lastEvent.t : 0;
  let prevScore = state.score.slice();
  let everPaired = false;

  function save() { store.set('aopb.state', state); }

  /* ---------- Rendering ---------- */
  function sideTeam(side) { return state.swapped ? 1 - side : side; } // side 0 = left

  function renderTeam(el, team, pub) {
    const s = state.settings;
    el.style.setProperty('--c', s.colors[team]);
    el.classList.toggle('serving', state.serving === team && !state.matchOver);
    el.querySelector('.team-name').textContent = s.names[team];
    const scoreEl = el.querySelector('.team-score');
    if (scoreEl.dataset.v !== String(state.score[team])) {
      scoreEl.dataset.v = state.score[team];
      scoreEl.innerHTML = seg(state.score[team], 2);
      if (state.score[team] > prevScore[team]) { scoreEl.classList.remove('bump'); void scoreEl.offsetWidth; scoreEl.classList.add('bump'); }
    }
    const tag = el.querySelector('.serve-tag');
    const dbl = s.mode === 'doubles' && s.scoring === 'sideout';
    const who = dbl ? (state.serverNum === 1 ? '1st server' : '2nd server') : 'Serving';
    const named = pub.hasPlayers ? esc(pub.serverName) + ' · ' : '';
    tag.innerHTML = ICON.ball + '<div>' + named + who + '<small>from ' + pub.serveSide.toLowerCase() + '</small></div>';
    const pl = el.querySelector('.team-players');
    pl.innerHTML = pub.hasPlayers ? pub.court[team].map((p) =>
      '<span class="pl' + (p.serving ? ' on' : '') + '">' + (s.mode === 'doubles' ? '<i>' + p.side + '</i>' : '') + esc(p.name) + '</span>').join('') : '';
    const need = Math.ceil(s.bestOf / 2);
    const pips = el.querySelector('.pips');
    if (s.bestOf > 1) {
      let h = '';
      for (let i = 0; i < need; i++) h += '<span class="pip' + (i < state.games[team] ? ' on' : '') + '"></span>';
      pips.innerHTML = h;
    } else pips.innerHTML = '';
  }

  function render() {
    const s = state.settings;
    document.documentElement.style.setProperty('--team-a', s.colors[0]);
    document.documentElement.style.setProperty('--team-b', s.colors[1]);
    const pub = E.publicState(state);
    renderTeam($('teamL'), sideTeam(0), pub);
    renderTeam($('teamR'), sideTeam(1), pub);

    const parts = [];
    parts.push(s.bestOf > 1 ? 'GAME <b>' + state.gameNo + '</b> · BEST OF ' + s.bestOf : 'SINGLE GAME');
    parts.push('TO ' + s.target);
    parts.push(s.scoring === 'rally' ? 'RALLY' : (s.mode === 'doubles' ? 'DOUBLES' : 'SINGLES'));
    $('meta').innerHTML = parts.join(' · ');

    $('callout').innerHTML = seg(E.callout(state));
    $('history').innerHTML = state.gameLog.map((g, i) => '<span>G' + (i + 1) + ' <b>' + g.a + '–' + g.b + '</b></span>').join('');

    // End-of-game / match overlay
    const end = $('endOverlay');
    if (state.matchOver) {
      $('endEyebrow').textContent = 'Match winner';
      $('endName').textContent = s.names[state.winner];
      $('endName').style.color = s.colors[state.winner];
      $('endGames').innerHTML = state.gameLog.map((g) => '<span>' + g.a + '–' + g.b + '</span>').join('');
      $('endHint').textContent = 'Start a new match from the remote · N';
      end.classList.remove('hidden');
    } else if (state.gameOver) {
      const w = state.gameLog[state.gameLog.length - 1].winner;
      $('endEyebrow').textContent = 'Game ' + state.gameNo;
      $('endName').textContent = s.names[w];
      $('endName').style.color = s.colors[w];
      $('endGames').innerHTML = '<span>' + state.games[0] + ' – ' + state.games[1] + ' in games</span>';
      $('endHint').textContent = 'Tap “Next game” on the remote · N';
      end.classList.remove('hidden');
    } else end.classList.add('hidden');

    // Event toast
    const ev = state.lastEvent;
    if (ev && ev.t !== lastEventT) {
      lastEventT = ev.t;
      const map = { partners: 'POSITIONS FIXED', sideout: 'SIDE OUT', second: '2ND SERVER', swap: ev.auto ? 'SWITCH ENDS' : 'SIDES SWAPPED', undo: 'UNDO', newgame: 'GAME ' + state.gameNo };
      if (map[ev.type]) toast(map[ev.type], ev.team != null ? s.colors[ev.team] : null);
    }
    prevScore = state.score.slice();
  }

  let toastT;
  function toast(text, color) {
    const t = $('toast');
    t.textContent = text; t.style.color = color || 'var(--ball)';
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1700);
  }

  /* ---------- Access (Google sign-in + day pass) ---------- */
  const AUTH = PBAuth.enabled;
  let license = store.get('aopb.license', null); // {until, name, email}
  const verified = new Set();                     // remote ids that signed in this session
  function licensed() { return !AUTH || (license && new Date(license.until).getTime() > Date.now()); }
  function hhmm(d) { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  function setPairMsg(text, kind) {
    const el = $('pairStatus'); if (!el) return;
    el.textContent = text || ''; el.className = 'pair-status' + (kind ? ' ' + kind : '');
  }

  function showDenied(title, body) {
    $('deniedTitle').textContent = title; $('deniedBody').textContent = body;
    $('deniedOverlay').classList.remove('hidden');
    clearTimeout(showDenied.t); showDenied.t = setTimeout(() => $('deniedOverlay').classList.add('hidden'), 9000);
  }

  async function onRemoteMessage(msg, reply, id) {
    if (msg.t !== 'auth') return;
    if (!AUTH) { verified.add(id); reply({ t: 'authok', free: true }); return; }
    setPairMsg('Checking account…');
    let res;
    try { res = await PBAuth.verifyToken(msg.token, { charge: !licensed() }); }
    catch (e) { res = { ok: false, reason: 'ERROR' }; }
    if (res.ok) {
      verified.add(id);
      if (res.until) { license = { until: res.until, name: res.name || '', email: res.email || '' }; store.set('aopb.license', license); }
      reply({ t: 'authok', until: license && license.until, name: res.name, credits: res.credits });
      $('deniedOverlay').classList.add('hidden');
      setPairMsg('');
      showPair(false);
      toast('WELCOME ' + String(res.name || res.email || '').split(' ')[0].toUpperCase());
      renderLicense();
    } else {
      reply({ t: 'denied', reason: res.reason, email: res.email });
      const who = res.email ? res.email : 'this account';
      if (res.reason === 'NO_CREDITS') { showDenied('Access denied', 'No credits on ' + who + '. Buy credits, then scan again.'); setPairMsg('Denied: no credits on ' + who, 'bad'); }
      else if (res.reason === 'NOT_SIGNED_IN') setPairMsg('Phone connected · waiting for Google sign-in');
      else { showDenied('Could not verify', 'Check the internet connection and try again.'); setPairMsg('Verification failed', 'bad'); }
    }
  }

  function renderLicense() {
    const el = $('passChip'); if (!el) return;
    if (!AUTH) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (licensed()) { el.classList.add('ok'); $('passTxt').textContent = 'Pass until ' + hhmm(license.until); }
    else { el.classList.remove('ok'); $('passTxt').textContent = 'Sign-in needed'; }
  }

  // Pass expiry: lock the board and ask remotes to sign in again (another credit is used).
  setInterval(() => {
    if (AUTH && license && !licensed()) {
      license = null; store.del('aopb.license'); verified.clear();
      if (link) link.broadcastMsg({ t: 'reauth' });
      showPair(true); setPairMsg('24-hour pass ended · scan to continue (uses 1 credit)');
    }
    renderLicense();
  }, 20000);

  function remoteAct(action, reply, id) {
    if (AUTH && !(licensed() && verified.has(id))) { reply({ t: licensed() ? 'needauth' : 'reauth' }); return; }
    act(action);
  }

  /* ---------- Actions ---------- */
  function act(action) {
    if (!licensed()) { toast('SCAN TO SIGN IN'); showPair(true); return; }
    if (action && action.a === 'rally' && action.side != null) action = { a: 'rally', team: sideTeam(action.side) };
    state = E.apply(state, action);
    save(); render();
    if (link) link.broadcast(E.publicState(state));
  }

  /* ---------- QR / pairing ---------- */
  function drawQr() {
    const url = remoteUrl();
    $('codeBig').textContent = code; $('codeMini').textContent = code; $('urlBig').textContent = url;
    if (typeof qrcode === 'undefined') {
      $('qrBig').innerHTML = '<div style="width:30vh;height:30vh;display:grid;place-items:center;color:#0b1228;font:600 2vh Josefin Sans, sans-serif;text-align:center;line-height:1.4;padding:2vh">QR unavailable offline<br>use the code</div>';
      $('qrMini').innerHTML = '';
      return;
    }
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const img = '<img alt="QR code to open the remote" src="' + qr.createDataURL(10, 0) + '">';
    $('qrBig').innerHTML = img; $('qrMini').innerHTML = img;
  }

  function showPair(show) {
    $('pairOverlay').classList.toggle('hidden', !show);
    if (show) setTimeout(() => $('pairClose').focus(), 50);
    updateMini();
  }
  function updateMini() {
    const pairOpen = !$('pairOverlay').classList.contains('hidden');
    $('miniQr').classList.toggle('hidden', pairOpen || !link || (link.remotes > 0 && licensed()));
  }

  function setLinkStatus(st) {
    const chip = $('linkChip'), txt = $('linkTxt');
    chip.classList.remove('ok', 'warn');
    const n = st.remotes || 0;
    if (st.state === 'online') {
      chip.classList.add(n ? 'ok' : 'warn');
      txt.textContent = n ? n + (n === 1 ? ' remote' : ' remotes') : 'Code ' + code;
      if (st.joined && AUTH && !licensed()) setPairMsg('Phone connected · waiting for Google sign-in');
      else if (st.joined && !everPaired) { everPaired = true; showPair(false); toast('REMOTE CONNECTED'); }
      else if (st.joined) toast('REMOTE CONNECTED');
    } else if (st.state === 'nolib') { chip.classList.add('warn'); txt.textContent = 'Offline · keys only'; }
    else if (st.state === 'newcode') { rotateCode(); return; }
    else { chip.classList.add('warn'); txt.textContent = st.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'; }
    updateMini();
  }

  function startLink() {
    if (link) link.destroy();
    link = PBLink.host({
      code,
      getState: () => E.publicState(state),
      onAction: remoteAct,
      onMessage: onRemoteMessage,
      onStatus: setLinkStatus
    });
  }

  function rotateCode() {
    code = PBLink.makeCode(); store.set('aopb.code', code);
    drawQr(); startLink(); showPair(true);
  }

  /* ---------- Fullscreen / UI ---------- */
  function fullscreen() {
    const d = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      (d.requestFullscreen || d.webkitRequestFullscreen || function () {}).call(d);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
    keepAwake();
  }
  $('fsBtn').innerHTML = ICON.full;
  $('fsBtn').onclick = fullscreen;
  $('pairFs').onclick = fullscreen;
  $('linkChip').onclick = () => showPair(true);
  $('miniQr').onclick = () => showPair(true);
  $('pairClose').onclick = () => { showPair(false); keepAwake(); };
  $('pairNew').onclick = () => { if (confirmNew()) rotateCode(); };
  function confirmNew() { return !link || link.remotes === 0 || window.confirm('Generate a new code? Connected remotes will need to rescan.'); }

  // Hide cursor when idle (TV look)
  let idleT;
  document.addEventListener('mousemove', () => {
    $('display').classList.remove('hide-cursor'); clearTimeout(idleT);
    idleT = setTimeout(() => $('display').classList.add('hide-cursor'), 2500);
  });

  // Keyboard / TV-remote control
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key;
    const pairOpen = !$('pairOverlay').classList.contains('hidden');
    if (pairOpen && (k === 'Escape' || k === 'Backspace')) { showPair(false); e.preventDefault(); return; }
    if (pairOpen) return; // let Enter activate focused button
    if (k === 'ArrowLeft' || k === 'a' || k === 'A' || k === '1') { act({ a: 'rally', side: 0 }); e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'l' || k === 'L' || k === '2') { act({ a: 'rally', side: 1 }); e.preventDefault(); }
    else if (k === 'u' || k === 'U' || k === 'z' || k === 'Backspace' || k === 'ArrowDown') { act({ a: 'undo' }); e.preventDefault(); }
    else if (k === 's' || k === 'S') act({ a: 'swap' });
    else if (k === 'q' || k === 'Q' || k === 'ArrowUp') { showPair(true); e.preventDefault(); }
    else if (k === 'f' || k === 'F') fullscreen();
    else if (k === 'n' || k === 'N' || k === 'Enter') {
      if (state.matchOver) act({ a: 'new' });
      else if (state.gameOver) act({ a: 'next' });
    }
  });

  // Keep in sync if another tab on this device changes state
  window.addEventListener('storage', (e) => {
    if (e.key === 'aopb.state' && e.newValue) { try { state = E.ensure(JSON.parse(e.newValue)); render(); } catch (err) {} }
  });

  /* ---------- Boot ---------- */
  if (AUTH) {
    $('pairTitle').textContent = 'Scan to sign in and start scoring';
    $('pairBody').textContent = 'Scan with your phone camera and continue with Google. Each sign-in starts a 24-hour pass that uses 1 credit, so buy credits before scanning.';
    if (licensed()) setPairMsg('Pass active until ' + hhmm(license.until) + ' · scan to connect a phone', 'ok');
  }
  renderLicense();
  render();
  drawQr();
  showPair(true);
  keepAwake();
  Promise.allSettled([loadScript(LIBS.qr), loadScript(LIBS.peer)]).then(() => { drawQr(); startLink(); });
})();
