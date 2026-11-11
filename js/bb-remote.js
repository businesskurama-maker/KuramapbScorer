/* Basketball LIVE OBS — smartphone scoring remote. Every tap becomes one server event with its own id. */
(function () {
  const $ = (id) => document.getElementById(id);
  const E = PBB.esc;
  const q = new URLSearchParams(location.search);
  const code = (q.get('m') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const TK = 'dk.bb.dev.' + code;
  const store = PBCommon.store;
  let dev = store.get(TK, null);           // {token, role, view_key, name, device}
  let conn = null, S = null, role = null, view = 'score';
  let selT = 'home', selP = null, showBench = false, teamOnly = false, fKind = 'P', statSign = 1, statP = null, plT = 'home', pending = null;

  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p || 40); } catch (e) {} };
  let toastT;
  function toast(t, err) { const el = $('toast'); el.textContent = t; el.classList.toggle('err', !!err); el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), err ? 3200 : 1800); }

  if (!code) { document.body.innerHTML = '<div class="r-join"><h1>🏀 Basketball <b>LIVE OBS</b></h1><p class="muted">Scan the QR code on the OBS Monitor to open the remote.</p><a class="btn" href="basketball.html">Open the Basketball portal</a></div>'; return; }

  /* ---------------- pairing ---------------- */
  function showJoin(msg, wrongAcct) {
    $('app').classList.add('hidden'); $('join').classList.remove('hidden');
    $('jCode').textContent = code.split('').join(' ');
    $('jMsg').textContent = msg || ''; $('join').classList.toggle('wrong-acct', !!wrongAcct);
    const r = q.get('r'); if (r === 'clock' || r === 'scorekeeper') setRoleSeg(r);
    $('jName').value = store.get('dk.bb.name', '');
    $('jAcct').classList.add('hidden'); $('jSignIn').classList.add('hidden');
    if (window.PBAuth && PBAuth.enabled) PBAuth.init().then(() => {
      if (PBAuth.user) { $('jHost').classList.remove('hidden'); $('jAcct').classList.remove('hidden'); $('jWho').textContent = PBAuth.user.email || 'Google account'; }
      else $('jSignIn').classList.remove('hidden');
    }).catch(() => {});
  }
  function setRoleSeg(v) { [...$('jRole').children].forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
  $('jRole').onclick = (e) => { const b = e.target.closest('button'); if (b) setRoleSeg(b.dataset.v); };
  $('jPin').oninput = () => { $('jPin').value = $('jPin').value.replace(/\D/g, '').slice(0, 6); };
  $('jGo').onclick = async () => {
    const pin = $('jPin').value, name = $('jName').value.trim(), r = [...$('jRole').children].find((b) => b.classList.contains('on')).dataset.v;
    if (pin.length !== 6) { $('jMsg').textContent = 'Enter the 6-digit PIN.'; return; }
    $('jGo').classList.add('busy'); $('jMsg').textContent = 'Pairing…';
    try {
      const c = await PBB.client(false);
      const res = await PBB.rpc(c, 'bb_pair', { p_code: code, p_pin: pin, p_role: r, p_name: name || (r === 'clock' ? 'Clock' : 'Scorekeeper') });
      if (!res.ok) { $('jMsg').textContent = res.reason === 'BAD_PIN' ? 'Wrong PIN. Check the OBS Monitor.' : 'Could not pair.'; return; }
      store.set('dk.bb.name', name);
      dev = { token: res.token, role: res.role, view_key: res.view_key, name, device: res.device }; store.set(TK, dev);
      buzz([30, 50, 30]); start(res.snap);
    } catch (e) { $('jMsg').textContent = PBB.errText(e); }
    finally { $('jGo').classList.remove('busy'); }
  };
  $('jHost').onclick = async () => {
    try {
      await PBAuth.init(); const h = await PBB.rpc(PBAuth.client, 'bb_host', { p_code: code });
      dev = { token: null, role: 'host', view_key: h.view_key, name: 'Host', host: true }; store.set(TK, dev); start(h);
    } catch (e) {
      const c = PBB.errCode(e);
      $('jMsg').textContent = c === 'NOT_AUTHORIZED' ? (PBAuth.user ? PBAuth.user.email + ' does not own this match. Tap Change account, or pair with the PIN.' : 'Sign in with the Google account that created this match.') : PBB.errText(e);
      if (c === 'NOT_AUTHORIZED') $('join').classList.add('wrong-acct');
    }
  };

  /* ---------------- layout per role / host duty ---------------- */
  // host phone keeps its host powers but works ONE job: referee (scoring) or timer operator (clock)
  function duty() { return role === 'host' ? (dev.duty || 'score') : role === 'clock' ? 'clock' : 'score'; }
  function applyLayout() {
    const d = duty(), clockOnly = d === 'clock', isHost = role === 'host';
    const tabs = clockOnly ? ['clock', 'settings'] : ['score', 'clock', 'players', 'events', 'settings'];
    document.querySelectorAll('.r-nav button').forEach((b) => b.classList.toggle('hidden', !tabs.includes(b.dataset.v)));
    document.body.classList.toggle('duty-clock', clockOnly);
    document.body.classList.toggle('duty-ref', isHost && !clockOnly);
    // referee host: Clock tab keeps only periods / overtime / end match; the timer runs the clocks
    $('clkBox').classList.toggle('hidden', isHost && !clockOnly);
    $('shotBox').classList.toggle('hidden', isHost && !clockOnly);
    const navClock = document.querySelector('.r-nav [data-v="clock"]');
    navClock.lastChild.textContent = isHost && !clockOnly ? 'Periods' : 'Clock';
    $('hReset').classList.toggle('hidden', role === 'clock');
    $('vSettings').querySelectorAll('.box').forEach((b, i) => b.classList.toggle('hidden', role === 'clock' && i < 4));
    $('perBox').classList.toggle('hidden', role === 'clock');
    $('pEnd').classList.toggle('hidden', role === 'clock');
    $('hRole').textContent = isHost ? (clockOnly ? 'HOST · TIMER' : 'HOST · REFEREE') : role === 'clock' ? 'CLOCK' : 'SCORER';
    $('hRole').classList.toggle('tap', isHost);
    $('dutyBtn').classList.toggle('hidden', !isHost);
    $('devTxt').textContent = (isHost ? 'Host (signed in) · ' + (clockOnly ? 'timer operator' : 'referee') : (dev.name || role) + ' · ' + role) + ' · match ' + code;
    if (clockOnly && !['clock', 'settings'].includes(view)) go('clock');
    else if (!clockOnly && view === 'clock' && role === 'host' && dev.duty) go('score');
    else go(view);
  }
  function pickDuty(first) {
    const cur = dev.duty;
    modal('<h3 style="margin:0 0 4px">' + (first ? 'What will this phone do?' : 'Switch duty') + '</h3>'
      + '<p class="tiny" style="margin:0 0 12px">You stay the host either way (end match, lock, overlay controls). Pick one job for this phone.</p>'
      + '<div class="duty-pick">'
      + '<button class="duty-o' + (cur === 'score' ? ' on' : '') + '" data-d="score"><span class="di">🏀</span><b>Referee</b><small>Points, fouls, timeouts, players, periods</small></button>'
      + '<button class="duty-o' + (cur === 'clock' ? ' on' : '') + '" data-d="clock"><span class="di">⏱️</span><b>Timer operator</b><small>Game clock and shot clock</small></button>'
      + '</div>' + (first ? '' : '<button class="btn ghost" data-close style="width:100%;margin-top:10px">Cancel</button>'),
    (m, e) => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      dev.duty = b.dataset.d; store.set(TK, dev); m.remove(); buzz([30, 40, 30]);
      view = dev.duty === 'clock' ? 'clock' : 'score'; applyLayout();
      toast(dev.duty === 'clock' ? 'This phone is the timer' : 'This phone is the referee');
    }, (m) => { if (first) m.classList.add('locked'); });
  }
  $('hRole').onclick = () => { if (role === 'host') pickDuty(false); };
  $('dutyBtn').onclick = () => pickDuty(false);

  /* ---------------- lost access: re-pair or switch account ---------------- */
  let takeover = false;
  function authFail(e) {
    const c = PBB.errCode(e);
    if (!['NOT_PAIRED', 'REVOKED', 'NO_MATCH', 'NOT_AUTHORIZED'].includes(c)) return false;
    if (c === 'NOT_AUTHORIZED' && !(dev && dev.host)) return false;
    const wasHost = dev && dev.host;
    store.del(TK); dev = null; try { conn && conn.close(); } catch (x) {} conn = null;
    showJoin(c === 'NOT_AUTHORIZED' ? 'This Google account does not own match ' + code + '. Change account, or pair with the PIN.'
      : c === 'REVOKED' && takeover ? 'Another phone took over scoring with the PIN. Enter the PIN to take it back.'
      : PBB.errText(e), wasHost && c === 'NOT_AUTHORIZED');
    return true;
  }
  async function changeAccount() {
    try { await PBAuth.init(); await PBAuth.signOut(); } catch (x) {}
    store.del(TK);
    const back = location.pathname + '?m=' + code + '&host=1';
    try { await PBAuth.init(); await PBAuth.signIn(back); } catch (x) { $('jMsg').textContent = 'Could not open Google sign-in. Check the internet.'; }
  }
  $('jSwitch').onclick = changeAccount;
  $('jSignIn').onclick = changeAccount;
  $('acctBtn').onclick = () => { if (confirm('Sign out of this Google account and sign in with another one?')) changeAccount(); };

  /* ---------------- connection ---------------- */
  function start(first) {
    $('join').classList.add('hidden'); $('app').classList.remove('hidden');
    role = dev.role;
    document.body.classList.toggle('is-host', role === 'host');
    document.querySelectorAll('.host-only').forEach((el) => el.classList.toggle('hidden', role !== 'host'));
    applyLayout();
    if (role === 'host' && !dev.duty) pickDuty(true);
    conn = PBB.connect({ code, key: dev.view_key, token: dev.token, signedIn: !!dev.host, autoReload: true, onSnap, onStatus, onError: authFail });
    if (first) conn.apply(first);
    // host phone: confirm this Google account still owns the match (catches a switched / wrong account early)
    if (dev.host && !first) PBAuth.init().then(() => { if (!PBAuth.user) throw new Error('NOT_AUTHORIZED'); return PBB.rpc(PBAuth.client, 'bb_host', { p_code: code }); }).catch((e) => authFail(e));
    PBCommon.keepAwake && PBCommon.keepAwake();
  }
  let wasOff = false, rcT = null;
  $('offBar').onclick = () => {   // manual reconnect; reload if it still can't connect
    if (!conn) return; $('offTxt').textContent = 'Reconnecting…'; conn.kick(true);
    clearTimeout(rcT); rcT = setTimeout(() => { if (conn && conn.status !== 'live') location.reload(); }, 6000);
  };
  function onStatus(st) {
    if (st === 'live' || st === 'connecting') { clearTimeout(rcT); $('offTxt').textContent = 'Connection lost — reconnecting automatically…'; }
    const live = st === 'live', el = $('hLive');
    el.className = 'r-live ' + (live ? '' : st === 'connecting' ? 'wait' : 'off');
    el.querySelector('span').textContent = live ? 'LIVE' : st === 'connecting' ? 'CONNECTING' : st === 'denied' ? 'NOT PAIRED' : 'OFFLINE';
    $('app').classList.toggle('offline', !live); $('offBar').classList.toggle('hidden', live || st === 'connecting');
    if (live && wasOff) { buzz([20, 40, 20]); toast('Back online · synced'); }
    wasOff = !live && st !== 'connecting';
  }

  /* ---------------- actions ---------------- */
  let busy = false;
  async function act(type, data, opts) {
    if (!conn) { toast('Not connected — action not sent', true); return null; }
    if (busy && !(opts && opts.force)) return null;
    busy = true; const id = PBB.uuid();
    try {
      let s;
      try { s = await conn.act(type, data, id); }
      catch (e) { if (/timeout|fetch|network/i.test(String(e.message))) s = await conn.act(type, data, id); else throw e; }   // retry with the SAME id: never double-counted
      return s;
    } catch (e) { buzz([80, 40, 80]); if (!authFail(e)) toast(e.message === 'OFFLINE' ? 'Not connected — reconnecting, try again' : PBB.errText(e), true); return null; }
    finally { busy = false; }
  }

  /* ---------------- render ---------------- */
  const team = (t) => (t === 'home' ? S.home : S.away);
  const P = (id) => (S.players || []).find((p) => p.id === id);
  const st = (id) => (S.derived.players || {})[id] || {};
  function onSnap(s, last) {
    S = s;
    const d = s.derived || {}, b = s.broadcast || {};
    document.documentElement.style.setProperty('--home', s.home.color); document.documentElement.style.setProperty('--away', s.away.color);
    $('hTitle').textContent = s.title || (s.home.short + ' vs ' + s.away.short);
    ['home', 'away'].forEach((t) => {
      const k = t === 'home' ? 'H' : 'A', T = team(t);
      $('n' + k).textContent = T.name; $('sc' + k).textContent = (d.score || {})[t] || 0;
      const tl = (d.tos.allow || 0) - (d.tos[t] || 0);
      $('m' + k).innerHTML = 'F ' + ((d.fouls || {})[t] || 0) + ((d.penalty || {})[t] ? ' <span class="pen">PEN</span>' : '') + (s.config.preset === 'basic' ? '' : ' · TO ' + tl) + (d.poss === t ? ' · ◆' : '');
    });
    document.querySelectorAll('.tsw button').forEach((bt) => { bt.textContent = team(bt.dataset.t).short || team(bt.dataset.t).name; });
    $('possTxt').textContent = d.poss ? '→ ' + team(d.poss).short : 'POSS';
    $('redoBtn').disabled = !s.can_redo;
    if (last && last.type === 'revoke' && dev && last.device === dev.device) { store.del(TK); conn.close(); showJoin('The host removed this device.'); return; }
    if (last && last.type === 'revoke' && last.takeover && dev && dev.role === last.role && dev.token) { takeover = true; conn.refresh(); }
    if (last) describeLast(last);
    renderScore(); renderClockStatic(); renderPlayers(); renderSettings();
    if (view === 'events') loadEventsSoon();
    if (s.status === 'final') $('lastTxt').textContent = 'FINAL · ' + d.score.home + '–' + d.score.away + (role === 'host' ? ' · reopen from the Clock tab' : '');
  }
  function describeLast(e) {
    if (!['score', 'foul', 'timeout', 'undo', 'redo', 'score_adj', 'edit'].includes(e.type)) return;
    $('lastTxt').textContent = (e.actor ? e.actor + ': ' : '') + describe(e);
  }
  function describe(e) {
    const p = e.player ? P(e.player) : e.player_id ? P(e.player_id) : null, T = e.team ? team(e.team) : null, d = e.data || {};
    const who = p ? '#' + p.number + ' ' + PBB.playerName(p, true) : (T ? T.short + ' team' : '');
    switch (e.type) {
      case 'score': return who + ' +' + e.value;
      case 'score_adj': return (T ? T.short : '') + ' manual ' + (e.value > 0 ? '+' : '') + e.value;
      case 'foul': return who + ' · ' + PBB.FOUL_SHORT[d.kind || 'P'] + ' foul';
      case 'timeout': return 'Timeout ' + (T ? T.name : '');
      case 'period': return 'Period → ' + PBB.periodLabel(d.to, S.config.periods);
      case 'possession': return 'Possession ' + (T ? T.short : 'cleared');
      case 'stat': return who + ' ' + (e.value > 0 ? '+' : '−') + String(d.key || '').toUpperCase();
      case 'sub': return (T ? T.short : '') + ' sub · IN ' + (d.in || []).map((id) => (P(id) || {}).number).join(',') + ' · OUT ' + (d.out || []).map((id) => (P(id) || {}).number).join(',');
      case 'lineup': return (T ? T.short : '') + ' lineup set';
      case 'undo': return 'Undo · ' + (d.what || '') + (T ? ' ' + T.short : '');
      case 'redo': return 'Redo · ' + (d.what || '');
      case 'edit': return 'Edited ' + (d.what || 'event');
      case 'clock': return 'Clock ' + (d.op || '').replace('_', ' ') + (d.op === 'set' ? ' ' + PBB.fmtClock(d.ms) : '') + (d.secs ? ' ' + d.secs : '');
      case 'overlay': return 'Overlay ' + (d.op || '') + (d.text ? ' · ' + d.text : '');
      case 'broadcast': return 'Broadcast settings changed';
      case 'final': return 'Match final'; case 'reopen': return 'Match reopened'; case 'lock': return 'Settings ' + (d.on ? 'locked' : 'unlocked');
      default: return e.type;
    }
  }

  /* SCORE view */
  function renderScore() {
    if (!S) return;
    $('teamSw').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === selT));
    $('vScore').style.setProperty('--c', team(selT).color);
    const on = (S.derived.oncourt || {})[selT] || [];
    let list = (S.players || []).filter((p) => p.team === selT && p.active);
    if (!showBench && on.length) list = list.filter((p) => on.includes(p.id));
    const html = list.map((p) => { const s2 = st(p.id); return '<button class="jb' + (selP === p.id ? ' on' : '') + (s2.out ? ' out' : '') + (on.length && !on.includes(p.id) ? ' bench' : '') + '" data-p="' + p.id + '"><b>' + E(p.number) + '</b><small>' + E(PBB.playerName(p, true)) + '</small>' + (s2.fouls ? '<span class="fc">' + s2.fouls + 'F</span>' : '') + '</button>'; }).join('')
      + '<button class="jb team' + (selP === 'team' ? ' on' : '') + '" data-p="team"><b>TEAM</b><small>no player</small></button>';
    $('jgrid').innerHTML = html;
    $('benchBtn').textContent = showBench ? 'On court only' : 'Show bench';
    $('benchBtn').classList.toggle('hidden', !on.length);
    const p = selP && selP !== 'team' ? P(selP) : null;
    $('selTxt').innerHTML = p ? 'Selected <b>#' + E(p.number) + ' ' + E(PBB.playerName(p)) + '</b> · ' + (st(p.id).pts || 0) + ' pts · ' + (st(p.id).fouls || 0) + ' F'
      : selP === 'team' || teamOnly ? '<b>' + E(team(selT).name) + '</b> · team-only' : 'Pick a player, then the points';
    $('teamOnly').textContent = 'Team-only: ' + (teamOnly ? 'ON' : 'off');
    { const miss = ['home', 'away'].find((t) => activeOf(t).length && !onOf(t).length); const ln = $('lnNeed');
      ln.classList.toggle('hidden', !miss || S.config.player_scoring === false || role === 'clock'); if (miss) { ln.dataset.t = miss; $('lnNeedT').textContent = team(miss).short || team(miss).name; } }
    $('fkind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === fKind));
  }
  $('teamSw').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; selT = b.dataset.t; selP = null; buzz(15); renderScore(); };
  $('jgrid').onclick = (e) => { const b = e.target.closest('.jb'); if (!b) return; selP = selP === b.dataset.p ? null : b.dataset.p; buzz(15); renderScore(); };
  $('benchBtn').onclick = () => { showBench = !showBench; renderScore(); };
  $('teamOnly').onclick = () => { teamOnly = !teamOnly; selP = null; renderScore(); };
  $('fkind').onclick = (e) => { const b = e.target.closest('button'); if (b) { fKind = b.dataset.k; renderScore(); } };
  $('pts').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b || !S) return;
    const playerMode = S.config.player_scoring !== false && !teamOnly;
    if (playerMode && !selP) { toast('Pick the player first (or TEAM)', true); buzz([60, 40, 60]); return; }
    buzz(45);
    const pid = selP && selP !== 'team' ? selP : null;
    b.classList.add('busy');
    const s = await act('score', { team: selT, player: pid, value: Number(b.dataset.v) });
    b.classList.remove('busy');
    if (s) { if (!teamOnly) selP = null; renderScore(); }
  };
  $('foulBtn').onclick = async () => {
    if (!S) return;
    const pid = selP && selP !== 'team' ? selP : null;
    if (!pid && fKind !== 'B' && !teamOnly && selP !== 'team') { toast('Pick the player who fouled (or TEAM)', true); return; }
    buzz(45);
    const s = await act('foul', { team: selT, player: pid, kind: fKind });
    if (s) {
      if (pid) { const x = st(pid); toast('#' + P(pid).number + ' · ' + x.fouls + ' foul' + (x.fouls === 1 ? '' : 's') + (x.out ? (x.dq ? ' · DISQUALIFIED' : ' · FOULED OUT') : '')); if (x.out) buzz([200, 80, 200]); }
      selP = null; fKind = 'P'; renderScore();
    }
  };
  $('toBtn').onclick = async () => {
    if (!S) return; buzz(45);
    const left = (S.derived.tos.allow || 0) - (S.derived.tos[selT] || 0);
    if (left <= 0 && !confirm('No timeouts left for ' + team(selT).name + ' in this period. Record anyway?')) return;
    const s = await act('timeout', { team: selT, force: left <= 0 });
    if (s) toast('Timeout ' + team(selT).name + ' · clock stopped');
  };
  $('undoBtn').onclick = async () => { buzz([20, 30, 20]); const s = await act('undo', {}); if (s) toast('Undone: ' + describeUndo(s.last)); };
  function describeUndo(l) { if (!l || !l.data) return 'last action'; const d = l.data; return (d.what || '') + (l.team ? ' · ' + team(l.team).short : '') + (d.value ? ' ' + d.value : ''); }
  $('redoBtn').onclick = async () => { buzz(30); const s = await act('redo', {}); if (s) toast('Redone'); };
  $('possBtn').onclick = async () => { if (!S) return; const cur = S.derived.poss; const nxt = cur === 'home' ? 'away' : cur === 'away' ? 'home' : selT; buzz(25); await act('possession', { team: nxt }); };
  $('hReset').onclick = async () => { buzz(60); const s = await act('overlay', { op: 'reset' }, { force: true }); if (s) toast('Overlay reset to the scoreboard'); };
  $('adjBtn').onclick = () => {
    if (!S) return;
    modal('<h3>Manual score edit</h3><div class="tiny">Corrections are saved in the audit log. Scores can never go below zero.</div>'
      + ['home', 'away'].map((t) => '<div class="box" style="--c:' + team(t).color + '"><h4><span style="color:var(--c)">' + E(team(t).name) + '</span><b style="font-family:var(--digit);font-size:22px;color:var(--c)">' + S.derived.score[t] + '</b></h4><div class="g4">'
        + [-3, -2, -1, 1].map((v) => '<button class="btn" data-t="' + t + '" data-v="' + v + '">' + (v > 0 ? '+' : '−') + Math.abs(v) + '</button>').join('') + '</div>'
        + '<div class="row"><input class="in grow" type="number" min="0" inputmode="numeric" placeholder="Set exact score" data-set="' + t + '"><button class="btn cyan" data-go="' + t + '">Set</button></div></div>').join('')
      + '<button class="btn" data-close>Close</button>', async (root, ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.v) { const s = await act('score_adj', { team: b.dataset.t, value: Number(b.dataset.v) }); if (s) root.querySelectorAll('h4 b')[b.dataset.t === 'home' ? 0 : 1].textContent = s.derived.score[b.dataset.t]; }
      if (b.dataset.go) { const t = b.dataset.go, v = parseInt(root.querySelector('[data-set="' + t + '"]').value, 10); if (isNaN(v) || v < 0) return; const delta = v - S.derived.score[t]; if (!delta) return;
        if (!confirm('Set ' + team(t).name + ' to ' + v + '? (' + (delta > 0 ? '+' : '') + delta + ')')) return;
        const s = await act('score_adj', { team: t, value: delta }); if (s) root.querySelectorAll('h4 b')[t === 'home' ? 0 : 1].textContent = s.derived.score[t]; }
    });
  };

  /* CLOCK view (numbers drawn every frame from the server timestamp) */
  function renderClockStatic() {
    if (!S) return;
    const c = S.config, d = S.derived;
    $('cPer').textContent = S.status === 'final' ? 'FINAL' : PBB.periodLabel(d.period, c.periods, true);
    $('cMode').textContent = c.timer_mode === 'external' ? 'Court timer mode — the overlay shows a window, this clock is for reference' : '';
    $('shotBox').classList.toggle('hidden', c.shot_on === false);
    $('sHide').textContent = (S.clock.shot || {}).hidden ? 'Show on overlay' : 'Hide on overlay';
    $('pFinal').textContent = S.status === 'final' ? 'Reopen match' : 'End match (final)';
    $('pOT').textContent = d.period >= c.periods ? 'Overtime ' + (d.period - c.periods + 1) : 'Overtime';
  }
  function frame() {
    requestAnimationFrame(frame);
    if (!S || !conn) return;
    const now = conn.serverNow(), ck = S.clock || {}, c = S.config || {};
    const left = PBB.clockLeft(ck, now), txt = PBB.fmtClock(left, c.tenths !== false);
    if ($('hClk').textContent !== txt) $('hClk').textContent = txt;
    $('hClk').className = 't ' + (ck.running && left > 0 ? 'run' : 'stop');
    $('hPer').textContent = S.status === 'final' ? 'FINAL' : PBB.periodLabel(S.derived.period, c.periods);
    const sh = ck.shot || {}, sl = PBB.clockLeft(sh, now);
    const shTxt = c.shot_on === false ? '' : PBB.fmtShot(sl);
    if ($('hShot').textContent !== shTxt) $('hShot').textContent = shTxt;
    if (view === 'clock') {
      if ($('cClk').textContent !== txt) $('cClk').textContent = txt;
      $('cClk').style.color = left === 0 ? 'var(--danger)' : ck.running ? '#fff' : 'var(--ink2)';
      $('cShot').textContent = PBB.fmtShot(sl);
      const run = ck.running && left > 0;
      const full = ((S.derived.period > c.periods ? c.ot_min : c.period_min) || 10) * 60000;
      $('cGo').textContent = run ? 'PAUSE' : left === 0 ? 'TIME — NEXT PERIOD' : left < full ? 'RESUME' : 'START';
      $('cGo').className = 'btn needs-live ' + (run ? 'danger' : 'primary');
      $('sGo').textContent = sh.running && sl > 0 ? 'Pause' : 'Start';
    }
  }
  requestAnimationFrame(frame);
  $('cGo').onclick = async () => {
    const ck = S.clock, left = PBB.clockLeft(ck, conn.serverNow());
    if (left === 0) { go('clock'); return $('pNext').click(); }
    buzz(50); await act('clock', { op: ck.running ? 'pause' : 'start' });
  };
  $('cEmerg').onclick = $('ovPause').onclick = async () => { buzz([80, 30, 80]); const s = await act('clock', { op: 'emergency' }, { force: true }); if (s) toast('Clock paused'); };
  $('cReset').onclick = async () => { if (confirm('Reset the game clock to the full period length?')) await act('clock', { op: 'reset' }); };
  $('cSet').onclick = async () => {
    const cur = PBB.fmtClock(PBB.clockLeft(S.clock, conn.serverNow()), false);
    const v = prompt('Set game clock (MM:SS or SS.t)', cur); if (v == null) return;
    const m = /^\s*(?:(\d{1,2}):)?(\d{1,2})(?:\.(\d))?\s*$/.exec(v); if (!m) { toast('Use MM:SS, e.g. 07:42', true); return; }
    const ms = ((Number(m[1] || 0) * 60) + Number(m[2])) * 1000 + Number(m[3] || 0) * 100;
    await act('clock', { op: 'set', ms });
  };
  $('s24').onclick = () => { buzz(30); act('clock', { op: 'shot_reset', secs: S.config.shot_full || 24 }); };
  $('s14').onclick = () => { buzz(30); act('clock', { op: 'shot_reset', secs: S.config.shot_short || 14 }); };
  $('sGo').onclick = () => { const sh = S.clock.shot || {}; act('clock', { op: sh.running ? 'shot_pause' : 'shot_start' }); };
  $('sSet').onclick = async () => { const v = prompt('Set shot clock (seconds)', '24'); if (v == null) return; const n = Number(v); if (!(n >= 0 && n <= 99)) return; await act('clock', { op: 'shot_set', ms: Math.round(n * 1000) }); };
  $('sHide').onclick = () => act('clock', { op: 'shot_off' });
  $('s24').textContent = '24';
  $('pNext').onclick = async () => {
    const p = S.derived.period, n = S.config.periods;
    if (p >= n && !confirm(S.derived.score.home === S.derived.score.away ? 'Start OVERTIME ' + (p - n + 1) + '?' : 'Regulation is over. Start overtime anyway? (Use End match to finish.)')) return;
    const s = await act('period', { to: p + 1 }); if (s) toast('Now ' + PBB.periodLabel(s.derived.period, n, true));
  };
  $('pOT').onclick = async () => { const p = S.derived.period, n = S.config.periods; if (!confirm('Start ' + (p >= n ? 'overtime ' + (p - n + 1) : 'overtime now (skipping remaining regulation periods)') + '?')) return; await act('period', { to: Math.max(p + 1, n + 1) }); };
  $('pPrev').onclick = async () => { const p = S.derived.period; if (p <= 1) return; if (!confirm('Go back to ' + PBB.periodLabel(p - 1, S.config.periods, true) + '? The clock resets to that period length.')) return; await act('period', { to: p - 1 }); };
  $('pEnd').onclick = async () => {
    const p = S.derived.period, n = S.config.periods;
    await act('clock', { op: 'pause' }, { force: true });
    const text = p === n / 2 && n % 2 === 0 ? 'HALFTIME' : p === n ? 'END OF REGULATION' : p > n ? 'END OF ' + PBB.periodLabel(p, n, true) : 'END OF ' + PBB.periodLabel(p, n, true);
    if (role !== 'clock') await act('overlay', { op: 'banner', kind: 'break', text, secs: 0 }, { force: true });
    toast(text);
  };
  $('pFinal').onclick = async () => {
    if (S.status === 'final') { if (confirm('Reopen this match? This is recorded in the audit log.')) await act('reopen', {}); return; }
    const d = S.derived;
    if (!confirm('End the match as FINAL?\n\n' + S.home.name + ' ' + d.score.home + ' — ' + d.score.away + ' ' + S.away.name + '\n\nScores and stats are saved; OBS shows the FINAL graphic.')) return;
    const s = await act('final', {}); if (s) toast('Final saved');
  };

  /* PLAYERS view: starting five, substitutions (one player or the whole five) + explicit stats */
  const STATS = [['reb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK'], ['tov', 'TOV'], ['fta', 'FTA'], ['fga', 'FGA']];
  let lnForce = null;   // team whose lineup is being re-picked
  const capOf = () => (S && S.config && S.config.format === '3x3' ? 3 : 5);
  const onOf = (t) => ((S.derived.oncourt || {})[t] || []).filter((id) => P(id));
  const activeOf = (t) => (S.players || []).filter((p) => p.team === t && p.active);
  const lineupMode = (t) => !onOf(t).length || lnForce === t;
  function renderPlayers() {
    if (!S) return;
    $('plSw').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === plT));
    $('vPlayers').style.setProperty('--c', team(plT).color);
    const on = onOf(plT), act = activeOf(plT), cap = capOf(), need = Math.min(cap, act.length), lm = lineupMode(plT);
    if (!pending || pending.t !== plT || pending.lm !== lm) pending = lm
      ? { t: plT, lm, set: new Set(on.length ? on : act.filter((p) => p.starter).map((p) => p.id).slice(0, cap)) }
      : { t: plT, lm, outs: new Set(), ins: new Set() };
    $('lnBox').classList.toggle('lm', lm);
    $('subAll').textContent = 'Change all ' + cap; $('subAll').classList.toggle('hidden', lm || !on.length);
    $('lnReset').classList.toggle('hidden', lm || !on.length || S.status === 'final');
    const row = (p, kind) => { const s2 = st(p.id), sel = statP === p.id;
      let btn = '', cls = '';
      if (kind === 'pick') { const on2 = pending.set.has(p.id); cls = on2 ? ' pk' : ''; btn = '<button class="ln-b' + (on2 ? ' pk' : '') + '" data-tog="1">' + (on2 ? 'STARTER ✓' : 'START') + '</button>'; }
      else if (kind === 'court') { const o = pending.outs.has(p.id); cls = ' court' + (o ? ' going-out' : ''); btn = '<button class="ln-b' + (o ? ' out' : '') + '" data-tog="1">' + (o ? 'OUT ▼' : 'SUB OUT') + '</button>'; }
      else { const i2 = pending.ins.has(p.id); cls = i2 ? ' going-in' : ''; btn = s2.out ? '<span class="ln-x">' + (s2.dq ? 'DISQUALIFIED' : 'FOULED OUT') + '</span>' : '<button class="ln-b' + (i2 ? ' in' : '') + '" data-tog="1">' + (i2 ? 'IN ▲' : 'SUB IN') + '</button>'; }
      return '<div class="pl-row' + cls + (sel ? ' stat-sel' : '') + (s2.out ? ' fo' : '') + '" data-p="' + p.id + '">' + (p.photo ? '<span class="n ph" style="background-image:url(' + E(p.photo) + ')"><b>' + E(p.number) + '</b></span>' : '<span class="n">' + E(p.number) + '</span>')
        + '<span class="nm" data-sel="1">' + E(PBB.playerName(p)) + '<small>' + s2.pts + ' PTS · ' + s2.fouls + ' F' + (s2.reb ? ' · ' + s2.reb + ' REB' : '') + (s2.ast ? ' · ' + s2.ast + ' AST' : '') + '</small></span>' + btn + '</div>'; };
    if (!act.length) { $('plList').innerHTML = '<div class="tiny">No players on this roster. The host can add players in the Basketball portal.</div>'; $('lnHint').textContent = ''; $('subApply').disabled = true; }
    else if (lm) {
      $('lnTitle').textContent = 'Starting ' + (cap === 5 ? 'five' : cap);
      const n = pending.set.size;
      $('lnHint').innerHTML = '<b class="' + (n === need ? 'ok' : '') + '">' + n + ' / ' + need + '</b> picked · tap START on the players who begin the game' + (lnForce ? ' · this replaces the players on court' : '');
      $('plList').innerHTML = act.map((p) => row(p, 'pick')).join('');
      $('subApply').textContent = n === need ? 'Confirm starting ' + (cap === 5 ? 'five' : cap) : 'Pick ' + (need - n > 0 ? need - n + ' more' : n - need + ' fewer');
      $('subApply').disabled = n !== need; $('subClear').textContent = lnForce ? 'Cancel' : 'Clear';
    } else {
      $('lnTitle').textContent = 'Substitution';
      const outs = [...pending.outs], ins = [...pending.ins], num = (id) => '#' + (P(id) || {}).number;
      $('lnHint').innerHTML = outs.length || ins.length
        ? '<span class="o">OUT ' + (outs.map(num).join(' ') || '—') + '</span> <span class="i">IN ' + (ins.map(num).join(' ') || '—') + '</span>' + (outs.length !== ins.length ? ' · pick ' + Math.abs(outs.length - ins.length) + ' more ' + (outs.length > ins.length ? 'IN' : 'OUT') : '')
        : 'Tap <b>SUB OUT</b> on court and <b>SUB IN</b> on the bench (one player or several), then apply.';
      const bench = act.filter((p) => !on.includes(p.id));
      $('plList').innerHTML = '<div class="ln-sec">ON COURT · ' + on.length + '</div>' + on.map((id) => row(P(id), 'court')).join('')
        + '<div class="ln-sec">BENCH · ' + bench.length + '</div>' + (bench.map((p) => row(p, 'bench')).join('') || '<div class="tiny">Nobody on the bench.</div>');
      const ok = outs.length && outs.length === ins.length;
      $('subApply').textContent = ok ? 'Apply substitution (' + outs.length + ' ⇄ ' + ins.length + ')' : 'Apply substitution';
      $('subApply').disabled = !ok; $('subClear').textContent = 'Clear';
    }
    const sp = statP && P(statP) && P(statP).team === plT ? P(statP) : null;
    $('statSel').innerHTML = sp ? 'Stats for <b>#' + E(sp.number) + ' ' + E(PBB.playerName(sp)) + '</b>' : 'Tap a player name above, then a stat.';
    $('statGrid').innerHTML = STATS.map(([k, l]) => '<button class="btn" data-k="' + k + '"' + (sp ? '' : ' disabled') + '>' + l + '<small>' + (sp ? st(sp.id)[k] || 0 : '–') + '</small></button>').join('');
  }
  $('plSw').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; plT = b.dataset.t; pending = null; lnForce = null; renderPlayers(); };
  $('plList').onclick = (e) => {
    const r = e.target.closest('.pl-row'); if (!r || !S) return; const id = r.dataset.p; if (!pending) renderPlayers();
    if (e.target.closest('[data-tog]')) {
      buzz(15);
      if (pending.lm) { if (pending.set.has(id)) pending.set.delete(id); else if (pending.set.size < Math.min(capOf(), activeOf(plT).length)) pending.set.add(id); else { toast('Already ' + pending.set.size + ' starters — tap one to remove it first', true); return; } }
      else if (onOf(plT).includes(id)) { pending.outs.has(id) ? pending.outs.delete(id) : pending.outs.add(id); }
      else { pending.ins.has(id) ? pending.ins.delete(id) : pending.ins.add(id); }
    } else statP = statP === id ? null : id;
    renderPlayers();
  };
  $('subAll').onclick = () => { if (!pending || pending.lm) return; buzz(20); const on = onOf(plT); const all = on.every((id) => pending.outs.has(id)); pending.outs = new Set(all ? [] : on); renderPlayers(); if (!all) toast('All ' + on.length + ' marked OUT · now tap ' + on.length + ' players IN'); };
  $('lnReset').onclick = () => { lnForce = plT; pending = null; renderPlayers(); };
  $('subClear').onclick = () => { if (pending && pending.lm && lnForce) lnForce = null; pending = null; renderPlayers(); };
  $('subApply').onclick = async () => {
    if (!pending) return;
    if (pending.lm) {
      const s = await act('lineup', { team: plT, ids: [...pending.set] });
      if (s) { lnForce = null; pending = null; toast('Starting ' + (capOf() === 5 ? 'five' : capOf()) + ' set · ' + team(plT).short); renderPlayers(); renderScore(); }
    } else {
      const s = await act('sub', { team: plT, in: [...pending.ins], out: [...pending.outs] });
      if (s) { const n = pending.ins.size; pending = null; toast('Substitution · ' + n + ' player' + (n === 1 ? '' : 's') + ' in'); renderPlayers(); renderScore(); }
    }
  };
  $('subQuick').onclick = () => { plT = selT; pending = null; lnForce = null; go('players'); };
  $('lnNeedGo').onclick = () => { plT = $('lnNeed').dataset.t || selT; pending = null; go('players'); };
  $('statSign').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; statSign = Number(b.dataset.v); [...$('statSign').children].forEach((x) => x.classList.toggle('on', x === b)); };
  $('statGrid').onclick = async (e) => { const b = e.target.closest('button'); if (!b || !statP) return; buzz(25); await act('stat', { team: plT, player: statP, key: b.dataset.k, value: statSign }); };

  /* EVENTS view */
  let evT = null, evCache = [];
  function loadEventsSoon() { clearTimeout(evT); evT = setTimeout(loadEvents, 500); }
  async function loadEvents() {
    try { evCache = await conn.events(); } catch (e) { toast(PBB.errText(e), true); return; }
    const canEdit = role !== 'clock';
    const FOLD = ['score', 'score_adj', 'foul', 'timeout', 'period', 'possession', 'stat', 'lineup', 'sub'];
    $('evList').innerHTML = evCache.slice(0, 250).map((e) => {
      const t = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const acts = canEdit && !e.undone && FOLD.includes(e.type) ? '<button class="btn sm" data-undo="' + e.id + '">Undo</button>' + (['score', 'foul', 'stat'].includes(e.type) ? '<button class="btn sm" data-edit="' + e.id + '">Edit</button>' : '') : '';
      return '<div class="ev' + (e.undone ? ' undone' : '') + '"><span class="pp">' + PBB.periodLabel(e.period, S.config.periods) + '</span><span><b>' + E(describe(e)) + '</b><small>' + t + ' · ' + E(e.actor || '') + (e.edited ? ' · edited' : '') + (e.undone ? ' · undone' : '') + '</small></span><span class="acts">' + acts + '</span></div>';
    }).join('') || '<div class="tiny">No events yet.</div>';
  }
  $('evRefresh').onclick = loadEvents;
  $('evList').onclick = async (e) => {
    const u = e.target.closest('[data-undo]'), ed = e.target.closest('[data-edit]');
    if (u) { if (!confirm('Undo this event? Scores and stats are recalculated.')) return; const s = await act('undo', { target: u.dataset.undo }); if (s) { toast('Undone'); loadEvents(); } }
    if (ed) editEvent(evCache.find((x) => x.id === ed.dataset.edit));
  };
  function editEvent(ev) {
    if (!ev) return;
    const pls = (S.players || []).filter((p) => p.team === ev.team);
    const opts = '<option value="">' + E(team(ev.team).name) + ' (no player)</option>' + pls.map((p) => '<option value="' + p.id + '"' + (p.id === ev.player_id ? ' selected' : '') + '>#' + E(p.number) + ' ' + E(PBB.playerName(p)) + '</option>').join('');
    modal('<h3>Edit event</h3><div class="tiny">' + E(describe(ev)) + ' · ' + PBB.periodLabel(ev.period, S.config.periods) + '</div>'
      + '<label class="f">Player<select class="in" id="edP">' + opts + '</select></label>'
      + (ev.type === 'score' ? '<label class="f">Points<select class="in" id="edV"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label>' : '')
      + (ev.type === 'foul' ? '<label class="f">Foul type<select class="in" id="edK">' + Object.keys(PBB.FOUL_SHORT).map((k) => '<option value="' + k + '"' + ((ev.data || {}).kind === k ? ' selected' : '') + '>' + PBB.FOUL_SHORT[k] + '</option>').join('') + '</select></label>' : '')
      + '<div class="g2"><button class="btn" data-close>Cancel</button><button class="btn primary" id="edGo">Save correction</button></div>', async (root, e) => {
      if (e.target.id !== 'edGo') return;
      const data = { target: ev.id, player: root.querySelector('#edP').value };
      if (ev.type === 'score') data.value = Number(root.querySelector('#edV').value);
      if (ev.type === 'foul') data.kind = root.querySelector('#edK').value;
      const s = await act('edit', data); if (s) { root.remove(); toast('Correction saved'); loadEvents(); }
    }, (root) => { const v = root.querySelector('#edV'); if (v) v.value = String(ev.value); });
  }

  /* SETTINGS view */
  let paintingSettings = false;
  function renderSettings() {
    if (!S || role === 'clock') return;
    paintingSettings = true;
    const b = S.broadcast || {}, locked = S.locked && role !== 'host';
    $('lockedTxt').textContent = S.locked ? (role === 'host' ? 'locked for scorekeepers' : 'locked by host') : '';
    $('bcBox').style.opacity = locked ? .5 : 1; $('bcBox').style.pointerEvents = locked ? 'none' : '';
    $('theme').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === (b.theme || 'electric')));
    document.querySelectorAll('[data-b]').forEach((el) => { if (document.activeElement !== el) el.value = String(b[el.dataset.b] != null ? b[el.dataset.b] : el.value); });
    document.querySelectorAll('[data-t]').forEach((el) => { if (el.type === 'checkbox') el.checked = b[el.dataset.t] !== false && !(el.dataset.t === 'show_title' && !b.show_title) && !(el.dataset.t === 'reduced_motion' && !b.reduced_motion); });
    if (document.activeElement !== $('bRound')) $('bRound').value = b.round || '';
    $('timerMode').value = S.config.timer_mode || 'digital';
    $('lockT').checked = !!S.locked;
    if (!document.activeElement || !$('teamEd').contains(document.activeElement)) {
      $('teamEd').innerHTML = ['home', 'away'].map((t) => { const T = team(t), other = team(t === 'home' ? 'away' : 'home');
        return '<div class="box" style="padding:10px;--c:' + T.color + '"><label class="f">' + t.toUpperCase() + ' name<input class="in" data-tn="' + t + '" maxlength="20" value="' + E(T.name) + '"></label>'
          + '<label class="f">Initials<input class="in" data-ts="' + t + '" maxlength="5" value="' + E(T.short) + '" style="text-transform:uppercase"></label>'
          + '<div class="sw-row">' + PBB.ELECTRIC.map((c) => '<button data-tc="' + t + '" data-c="' + c + '" style="--c:' + c + '" class="' + (c === T.color ? 'on' : '') + (PBB.colorDist(c, other.color) < PBB.MIN_DIST ? ' blocked' : '') + '"></button>').join('') + '</div>'
          + '<label class="btn sm" style="position:relative;overflow:hidden">' + (T.logo ? 'Change logo' : 'Upload logo') + '<input type="file" accept="image/*" data-tl="' + t + '" style="position:absolute;inset:0;opacity:0"></label>'
          + (T.logo ? '<button class="btn sm ghost" data-tx="' + t + '">Remove logo</button>' : '') + '</div>'; }).join('');
    }
    look.paint(); $('lookBox').style.opacity = locked ? .5 : 1; $('lookBox').style.pointerEvents = locked ? 'none' : '';
    $('brk').innerHTML = PBB.BREAKS.map(([t, s]) => '<button class="btn" data-brk="' + E(t) + '" data-sub="' + E(s) + '">' + E(t) + '</button>').join('');
    paintingSettings = false;
  }
  const bcast = (data) => act('broadcast', data, { force: true });
  const look = PBB.lookPanel($('lookPanel'), () => S && S.broadcast, (patch) => bcast({ patch }).then((s) => s && buzz(15)));
  $('theme').onclick = (e) => { const b = e.target.closest('button'); if (b) bcast({ patch: { theme: b.dataset.v, show_title: b.dataset.v === 'tournament' ? true : (S.broadcast.show_title || false) } }); };
  document.querySelectorAll('[data-b]').forEach((el) => el.addEventListener('change', () => { const v = el.value; bcast({ patch: { [el.dataset.b]: isNaN(Number(v)) ? v : Number(v) } }); }));
  document.querySelectorAll('input[data-t]').forEach((el) => el.addEventListener('change', () => bcast({ patch: { [el.dataset.t]: el.checked } })));
  $('bRound').onchange = () => bcast({ patch: { round: $('bRound').value.trim() } }).then((s) => s && toast($('bRound').value.trim() ? 'Round banner updated' : 'Round cleared'));
  $('timerMode').onchange = () => bcast({ timer_mode: $('timerMode').value });
  $('lockT').onchange = () => act('lock', { on: $('lockT').checked }, { force: true });
  $('teamEd').addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.tn) bcast({ [el.dataset.tn]: { name: el.value.trim().slice(0, 20) || team(el.dataset.tn).name } });
    if (el.dataset.ts) bcast({ [el.dataset.ts]: { short: el.value.trim().toUpperCase() } });
    if (el.dataset.tl && el.files[0]) { const f = el.files[0]; el.value = ''; try { const logo = await PBB.cropLogo(f); bcast({ [el.dataset.tl]: { logo } }); } catch (x) { if (x.message !== 'CANCELLED') toast(x.message || 'Could not read that image', true); } }
  });
  $('teamEd').addEventListener('click', (e) => {
    const c = e.target.closest('[data-tc]'); if (c) { const t = c.dataset.tc, other = team(t === 'home' ? 'away' : 'home'); if (PBB.colorDist(c.dataset.c, other.color) < PBB.MIN_DIST) { toast(PBB.errText('COLORS_TOO_CLOSE'), true); return; } bcast({ [t]: { color: c.dataset.c } }); }
    const x = e.target.closest('[data-tx]'); if (x) bcast({ [x.dataset.tx]: { logo: '' } });
  });
  $('brk').onclick = async (e) => { const b = e.target.closest('[data-brk]'); if (!b) return; buzz(30);
    const text = b.dataset.brk; const final = text === 'FINAL SCORE';
    const s = await act('overlay', { op: 'banner', kind: final ? 'final' : 'break', text, sub: b.dataset.sub || '', secs: 0 }, { force: true }); if (s) toast('On air: ' + text); };
  $('annGo').onclick = async () => { const t = $('annTxt').value.trim(); if (!t) return; const s = await act('overlay', { op: 'banner', kind: 'break', text: t, secs: 0 }, { force: true }); if (s) { toast('On air: ' + t.toUpperCase()); $('annTxt').value = ''; } };
  $('ovReset').onclick = () => $('hReset').click();
  $('ovHide').onclick = () => act('overlay', { op: 'hide' }, { force: true }).then((s) => s && toast('Overlay hidden'));
  $('ovShow').onclick = () => act('overlay', { op: 'show' }, { force: true }).then((s) => s && toast('Overlay visible'));
  $('ovClear').onclick = () => act('overlay', { op: 'clear' }, { force: true }).then((s) => s && toast('Announcement cleared'));
  $('leaveBtn').onclick = () => { if (!confirm('Leave this match on this phone? You will need the PIN to pair again.')) return; store.del(TK); location.reload(); };
  let bip = null; addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); bip = e; });
  $('instBtn').onclick = async () => { if (bip) { bip.prompt(); bip = null; } else toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Safari: Share → Add to Home Screen' : 'Use the browser menu → Install app / Add to Home screen'); };

  /* ---------------- navigation ---------------- */
  function go(v) {
    view = v;
    document.querySelectorAll('.r-nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    ['score', 'clock', 'players', 'events', 'settings'].forEach((k) => $('v' + k[0].toUpperCase() + k.slice(1)).classList.toggle('hidden', k !== v));
    if (v === 'events') loadEvents();
    if (v === 'players' && S) renderPlayers();
  }
  document.querySelector('.r-nav').onclick = (e) => { const b = e.target.closest('button'); if (b) { buzz(10); go(b.dataset.v); } };

  /* tiny modal helper */
  function modal(html, onClick, onOpen) {
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="sheet">' + html + '</div>';
    m.addEventListener('click', (e) => { if ((e.target === m && !m.classList.contains('locked')) || e.target.closest('[data-close]')) { m.remove(); return; } onClick && onClick(m, e); });
    document.body.appendChild(m); onOpen && onOpen(m); return m;
  }

  /* ---------------- boot ---------------- */
  PBCommon.registerSW && PBCommon.registerSW();
  if (dev && (dev.token || dev.host)) start(null);
  else if (q.get('host') === '1') { showJoin(''); $('jHost').classList.remove('hidden'); setTimeout(() => $('jHost').click(), 300); }
  else showJoin('');
  window.__bbRemote = { get S() { return S; }, get conn() { return conn; } };
})();
