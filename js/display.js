(function () {
  const { seg, store, ICON, keepAwake, registerSW, loadScript, LIBS, esc } = PBCommon;
  const E = PBEngine;
  const $ = (id) => document.getElementById(id);

  registerSW();

  /* ---------- State ---------- */
  let state = store.get('aopb.state', null);
  if (!state || state.v !== 1) state = E.newMatch();
  state = E.ensure(state);
  // A refresh after a finished match starts a fresh match (same names & settings) instead of sticking on the winner screen
  if (state.matchOver) { state = E.newMatch(state.settings); store.set('aopb.state', state); }

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
    el.classList.toggle('serving', state.serving === team && !state.matchOver && !state.playForServe);
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

    $('callout').innerHTML = state.playForServe ? '<span class="pfs-call">SERVE RALLY</span>' : seg(E.callout(state));
    $('pfsBanner').classList.toggle('hidden', !state.playForServe);
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
      const map = { pfs: (s.names[ev.team] || '') + ' SERVES FIRST', partners: 'POSITIONS FIXED', sideout: 'SIDE OUT', second: '2ND SERVER', swap: ev.auto ? 'SWITCH ENDS' : 'SIDES SWAPPED', undo: 'UNDO', newgame: 'GAME ' + state.gameNo };
      const scoreEv = { point: 1, sideout: 1, second: 1, undo: 1, server: 1 }[ev.type] && !state.gameOver && !state.matchOver && !state.playForServe;
      if (scoreEv) callFlash(map[ev.type] || '', ev.team != null ? s.colors[ev.team] : null);   // big score call so small screens can read it
      else if (map[ev.type]) toast(map[ev.type], ev.team != null ? s.colors[ev.team] : null);
      announce(ev);
    }
    prevScore = state.score.slice();
  }

  // Voice: a loud female voice calls the score (e.g. "four, two, one") and announces the winner
  function nameItem(t) {
    const n = String(state.settings.names[t] || '').trim();
    if (!n || /^TEAM [AB]$/i.test(n)) return t ? 'teamb' : 'teama';
    return { tts: n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), fallback: t ? 'teamb' : 'teama' };
  }
  function announce(ev) {
    if (!window.PBVoice || state.settings.voice === 0) return;
    const V = PBVoice, call = V.callItems(E.callout(state)), gap = { gap: .18 };
    let items = null;
    switch (ev.type) {
      case 'point': case 'undo': case 'server': items = state.gameOver || state.matchOver || state.playForServe ? null : call; break;
      case 'sideout': items = ['sideout', gap].concat(call); break;
      case 'second': items = ['second', gap].concat(call); break;
      case 'pfsStart': items = ['pfs']; break;
      case 'pfs': items = [nameItem(ev.team), 'servesfirst', gap].concat(call); break;
      case 'newgame': items = ['gameno', V.num(state.gameNo), gap].concat(call); break;
      case 'game': case 'match': {
        const g = state.gameLog[state.gameLog.length - 1] || { a: 0, b: 0 };
        const ws = ev.team ? g.b : g.a, ls = ev.team ? g.a : g.b;
        items = ev.type === 'match' ? ['match', gap, nameItem(ev.team), 'winsmatch', gap, V.num(ws), V.num(ls)]
                                    : ['game', gap, nameItem(ev.team), 'winsgame', gap, V.num(ws), V.num(ls)];
        break;
      }
    }
    if (items && items.length) V.say(items);
  }
  // Browsers only play sound after a tap/click on the page: show a chip until the voice is unlocked
  function updateSoundChip() {
    const c = $('soundChip'); if (!c) return;
    const need = window.PBVoice && PBVoice.supported && state.settings.voice !== 0 && !PBVoice.ready();
    c.classList.toggle('hidden', !need);
  }
  if ($('soundChip')) {
    $('soundChip').onclick = () => { if (window.PBVoice) { PBVoice.unlock(); setTimeout(() => { PBVoice.say(PBVoice.callItems(E.callout(state))); updateSoundChip(); }, 150); } };
    if (window.PBVoice) { PBVoice.load(); PBVoice.onState(updateSoundChip); }
    setInterval(updateSoundChip, 2000); setTimeout(updateSoundChip, 300);
  }

  // Big score call (e.g. 4-2-1) shown for a few seconds after every rally, readable on laptops and tablets
  let flashT;
  function callFlash(label, color) {
    const f = $('callFlash'); if (!f) return;
    $('cfLabel').textContent = label; $('cfLabel').style.color = color || 'var(--ball)';
    $('cfLabel').classList.toggle('hidden', !label);
    $('cfCall').innerHTML = seg(E.callout(state));
    f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 3000);
  }
  let toastT;
  function toast(text, color) {
    const t = $('toast');
    t.textContent = text; t.style.color = color || 'var(--ball)';
    // long messages (e.g. "KONG SMASHERS SERVES FIRST") shrink to fit the screen width
    t.style.fontSize = '';
    const maxW = window.innerWidth * 0.92, w = t.scrollWidth;
    if (w > maxW) t.style.fontSize = (parseFloat(getComputedStyle(t).fontSize) * maxW / w).toFixed(1) + 'px';
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1700);
  }

  /* ---------- Access (Google sign-in + day pass) ---------- */
  const AUTH = PBAuth.enabled;
  let license = store.get('aopb.license', null); // {until, name, email}
  const verified = new Set();                     // remote ids that signed in this session
  function licensed() { return !AUTH || (license && new Date(license.until).getTime() > Date.now()); }
  function hhmm(d) { const t = new Date(d); const far = t - Date.now() > 20 * 3600e3; return (far ? t.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '') + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  function setPairMsg(text, kind) {
    const el = $('pairStatus'); if (!el) return;
    el.textContent = text || ''; el.className = 'pair-status' + (kind ? ' ' + kind : '');
  }

  function showDenied(title, body) {
    $('deniedTitle').textContent = title; $('deniedBody').textContent = body;
    $('deniedOverlay').classList.remove('hidden');
    showPair(true);   // the QR page sits underneath, so the board is ready for the next scan
    clearTimeout(showDenied.t);
    showDenied.t = setTimeout(() => {   // short notice, then back to the QR page
      $('deniedOverlay').classList.add('hidden');
      if (!licensed()) { showPair(true); setPairMsg('No scoring time yet? Support DinkyKong on your phone, then scan again'); }
    }, 5000);
  }

  async function onRemoteMessage(msg, reply, id) {
    if (msg.t === 'release') { restartBoard('exit'); return; }   // remote signed out / exited the scoreboard
    if (msg.t !== 'auth') return;
    if (!AUTH) { verified.add(id); reply({ t: 'authok', free: true }); return; }
    setPairMsg('Checking account…');
    let res;
    try { res = await PBAuth.verifyToken(msg.token, { device: msg.device }); }
    catch (e) { res = { ok: false, reason: 'ERROR' }; }
    if (msg.silent) {   // periodic re-check: keep playing quietly, or end the pass if the owner undid the approval
      if (res.ok) {
        if (res.until) { license = { until: res.until, name: res.name || '', email: res.email || '' }; store.set('aopb.license', license); renderLicense(); }
        reply({ t: 'authok', silent: true, until: res.until });
      } else if (res.reason === 'NO_CREDITS') {
        verified.delete(id);
        if (!verified.size) { license = null; store.del('aopb.license'); renderLicense(); }
        reply({ t: 'denied', reason: res.reason, email: res.email });
        showDenied('Pass ended', 'The scoring time on ' + (res.email || 'this account') + ' was changed by the owner. Support DinkyKong on your phone to keep playing.');
      }
      return;
    }
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
      if (res.reason === 'NO_CREDITS') { showDenied('Access denied', 'No scoring time on ' + who + '. Support the DinkyKong fund on your phone to unlock time, then scan again.'); setPairMsg('Denied: no pass on ' + who, 'bad'); }
      else if (res.reason === 'OTHER_DEVICE') { showDenied('Access denied', who + ' is locked to another phone. Passes cannot be shared.'); setPairMsg('Denied: account locked to another phone', 'bad'); }
      else if (res.reason === 'NOT_SIGNED_IN') setPairMsg('Phone connected · waiting for Google sign-in');
      else setPairMsg('Choose a pass on your phone to start');
    }
  }

  // QR screen: who is signed in on this scoreboard right now, with a way to hand it to someone else
  function renderPairUser() {
    const box = $('pairUser'); if (!box) return;
    const on = AUTH && licensed() && license;
    box.classList.toggle('hidden', !on);
    $('pairTitle').textContent = on ? 'Scan to connect a phone' : (AUTH ? 'Scan to sign in and start scoring' : 'Scan to use your phone as the remote');
    if (!on) return;
    const nm = license.name || (license.email ? license.email.split('@')[0] : 'Signed-in player');
    $('puName').textContent = nm;
    const n = link ? link.remotes : 0;
    $('puPass').textContent = (license.email && license.name ? license.email + ' · ' : '') + 'Pass until ' + hhmm(license.until) + (n ? ' · ' + n + (n === 1 ? ' phone' : ' phones') : '');
  }
  function newUser() {
    const nm = (license && (license.name || license.email)) || 'the current player';
    if (!window.confirm('Connect a new user? ' + nm + ' will be signed out of this scoreboard and the score resets. Their pass time stays on their account.')) return;
    try { if (link) link.broadcastMsg({ t: 'reset' }); } catch (e) {}
    store.del('aopb.license'); license = null; verified.clear();
    state = E.newMatch(); save(); render();
    renderLicense();
    setTimeout(() => { rotateCode(); setPairMsg('Ready for a new user · scan to sign in'); }, 400);   // let remotes get the reset first
  }
  $('puNew').onclick = newUser;
  $('userChip').onclick = newUser;

  function renderLicense() {
    const el = $('passChip'); if (!el) return;
    if (!AUTH) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (licensed()) { el.classList.add('ok'); $('passTxt').textContent = 'Pass until ' + hhmm(license.until); }
    else { el.classList.remove('ok'); $('passTxt').textContent = 'Sign-in needed'; }
    renderPairUser();
    $('userChip').classList.toggle('hidden', !licensed());
  }

  // Every 5 minutes ask signed-in remotes to re-check their pass (picks up an approval the owner undid)
  setInterval(() => { if (AUTH && link && verified.size) link.broadcastMsg({ t: 'recheck' }); }, 5 * 60 * 1000);

  // Pass expiry: lock the board and ask remotes to sign in again (another credit is used).
  setInterval(() => {
    if (AUTH && license && !licensed()) {
      license = null; store.del('aopb.license'); verified.clear();
      if (link) link.broadcastMsg({ t: 'reauth' });
      showPair(true); setPairMsg('Pass ended · scan to continue');
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
    if (show) renderPairUser();
    if (show) setTimeout(() => $('pairClose').focus(), 50);
    updateMini();
  }
  function updateMini() {
    const pairOpen = !$('pairOverlay').classList.contains('hidden');
    $('miniQr').classList.toggle('hidden', pairOpen || !link || (link.remotes > 0 && licensed()));
    if (pairOpen) renderPairUser();
  }

  function setLinkStatus(st) {
    const chip = $('linkChip'), txt = $('linkTxt');
    chip.classList.remove('ok', 'warn');
    const n = st.remotes || 0;
    if (st.state === 'online') {
      chip.classList.add(n ? 'ok' : 'warn');
      txt.textContent = n ? n + (n === 1 ? ' remote' : ' remotes') : 'Code ' + code;
      if (st.joined) used = true;
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

  /* ---------- Live "who's online" status for the lobby / QR screen ---------- */
  let liveHandle = null;
  const boardLive = () => !!(link && link.remotes > 0 && licensed());
  PBAuth.live('b-' + Math.random().toString(36).slice(2, 10), { r: 'board', live: false }, (s) => {
    ['lobbyStats', 'pairStats'].forEach((id) => { const el = $(id); if (!el) return; el.innerHTML = PBCommon.liveText(s); el.classList.remove('hidden'); });
  }).then((h) => { liveHandle = h; }).catch(() => {});
  let lastLive = false;
  setInterval(() => { const v = boardLive(); if (liveHandle && v !== lastLive) { lastLive = v; liveHandle.update({ r: 'board', live: v }); } }, 5000);

  /* ---------- Restart for the next players ---------- */
  // When the remote signs out or exits, or no remote is connected for 3 minutes, the board resets:
  // new code, fresh match, pass cleared, back to the splash + lobby, then a new QR.
  const IDLE_MS = 3 * 60 * 1000;
  let used = false, restarting = false, aloneSince = 0;
  function restartBoard(reason) {
    if (restarting) return; restarting = true;
    try { if (link) link.broadcastMsg({ t: 'reset' }); } catch (e) {}
    store.del('aopb.license'); license = null; verified.clear();
    store.set('aopb.state', E.newMatch());
    store.set('aopb.code', PBLink.makeCode());
    $('byeTitle').textContent = reason === 'idle' ? 'Scoreboard is free' : 'Thanks for playing!';
    $('byeBody').textContent = reason === 'idle' ? 'No remote connected for 3 minutes · restarting for the next players…' : 'Remote signed out · restarting for the next players…';
    $('idleBanner').classList.add('hidden');
    $('byeOverlay').classList.remove('hidden');
    setTimeout(() => { try { if (link) link.destroy(); } catch (e) {} location.replace('./'); }, 3000);
  }
  setInterval(() => {
    const n = link ? link.remotes : 0;
    const banner = $('idleBanner');
    if (!used || restarting || n > 0) { aloneSince = 0; banner.classList.add('hidden'); return; }
    if (!aloneSince) aloneSince = Date.now();
    const left = IDLE_MS - (Date.now() - aloneSince);
    if (left <= 0) { restartBoard('idle'); return; }
    const sec = Math.ceil(left / 1000);
    banner.textContent = 'No remote connected · scoreboard restarts in ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    banner.classList.remove('hidden');
  }, 1000);

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
    if (!$('chooser').classList.contains('hidden')) return;
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

  /* ---------- Device role chooser (Scoreboard is the default) ---------- */
  (function chooser() {
    const q = new URLSearchParams(location.search);
    const el = $('chooser'); let left = 30, t;
    // DinkyKong animation: transparent WebM (Chrome, Android, TVs); animated WebP on Safari/iOS (no WebM alpha there)
    const startAnim = () => {
      const v = $('dkVideo'); if (!v || v.tagName !== 'VIDEO') return; const ua = navigator.userAgent;
      const safari = /iP(hone|ad|od)/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|CriOS|Android|Edg/.test(ua));
      const webm = !!(v.canPlayType && v.canPlayType('video/webm; codecs="vp9"'));
      if (safari || !webm) { const img = new Image(); img.className = 'dk-video'; img.id = 'dkVideo'; img.alt = ''; img.src = 'icons/dk-anim.webp'; v.replaceWith(img); return; }
      v.src = 'icons/dk-anim.webm'; v.play().catch(() => {});
    };
    const stopAnim = () => { const v = $('dkVideo'); if (v && v.pause) { v.pause(); v.removeAttribute('src'); v.load(); } };
    const pickDisplay = () => { clearInterval(t); stopAnim(); try { sessionStorage.setItem('aopb.tabRole', 'display'); } catch (e) {} try { localStorage.setItem('aopb.role', 'display'); } catch (e) {} el.classList.add('hidden'); keepAwake(); };
    $('asDisplay').onclick = pickDisplay;
    const pause = () => { clearInterval(t); $('chooserCount').textContent = 'Choose Scoreboard, Remote or LIVE'; };
    PBCommon.installButton($('installApp'), { onHelp: (h) => { pause(); const p = $('installHelp'); p.textContent = h; p.classList.remove('hidden'); } });
    $('installApp').addEventListener('click', pause);
    $('asLive').onclick = () => { clearInterval(t); stopAnim(); location.href = 'live.html'; };
    $('asRemote').onclick = () => { clearInterval(t); try { localStorage.setItem('aopb.role', 'remote'); } catch (e) {} location.href = 'remote.html?scan=1'; };
    el.addEventListener('keydown', (e) => {   // TV remote arrows move between the three choices
      const opts = [$('asDisplay'), $('asRemote'), $('asLive')]; const i = Math.max(0, opts.indexOf(document.activeElement));
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') opts[Math.min(2, i + 1)].focus();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') opts[Math.max(0, i - 1)].focus();
      e.stopPropagation();
    });
    // timed: first launch counts down to Scoreboard; from the "Main menu" button it waits for a choice
    const open = (timed) => {
      clearInterval(t); el.classList.remove('hidden'); $('asDisplay').focus(); startAnim();
      if (!timed) { pause(); return; }
      left = 30; $('chooserCount').textContent = 'Starting as Scoreboard in ' + left + ' s';
      t = setInterval(() => { left--; $('chooserCount').textContent = 'Starting as Scoreboard in ' + left + ' s'; if (left <= 0) pickDisplay(); }, 1000);
    };
    $('pairMenu').onclick = () => {
      if (link && link.remotes > 0 && !window.confirm('Go back to the main menu? The connected remote stays linked if you choose Scoreboard again.')) return;
      open(false);
    };
    $('menuChip').onclick = () => $('pairMenu').click();
    document.addEventListener('keydown', (e) => { if ((e.key === 'm' || e.key === 'M') && el.classList.contains('hidden') && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) $('pairMenu').click(); });
    if (q.get('role') === 'display' || q.get('c')) return;   // every launch / restart shows the lobby
    if (q.get('menu')) { history.replaceState(null, '', location.pathname); open(false); return; }   // back from the remote: wait for a choice
    setTimeout(() => open(true), document.getElementById('splash') ? 5200 : 0);
  })();

  /* ---------- Boot ---------- */
  if (AUTH) {
    $('pairTitle').textContent = 'Scan to sign in and start scoring';
    $('pairBody').textContent = 'Scan with your phone camera and continue with Google. New players get 2 days free. After that, a donation to the DinkyKong support fund unlocks scoring time (PHP 50 = 24 hours) on one account and one phone.';
    if (licensed()) setPairMsg('Pass active until ' + hhmm(license.until) + ' · scan to connect a phone', 'ok');
  }
  renderLicense();
  render();
  drawQr();
  showPair(true);          // every refresh shows the pairing QR; it hides itself when a remote (re)connects
  keepAwake();
  Promise.allSettled([loadScript(LIBS.qr), loadScript(LIBS.peer)]).then(() => { drawQr(); startLink(); });
})();
