/* Basketball LIVE OBS — broadcast overlay (OBS Browser Source, 1920×1080, transparent).
 * Read-only: it only knows the match code and the view key. */
(function () {
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const code = (q.get('m') || '').toUpperCase(), key = q.get('k') || '';
  if (q.get('preview')) document.body.classList.add('preview');
  if (q.get('preview') === 'photo') document.body.classList.add('photo');
  const stage = $('stage');
  const BOARD = document.body.classList.contains('board');   // venue scoreboard (bb-board.html) reuses this engine
  // venue scoreboard: classic seven-segment LED digits (same as the DinkyKong pickleball board)
  const segNum = (str, pad) => (window.PBCommon && PBCommon.seg) ? PBCommon.seg(String(str).replace(/[^0-9 -]/g, ''), pad) : PBB.esc(str);
  const segClock = (t) => String(t).split(/([:.])/).map((x) => x === ':' ? '<i class="sg-col"></i>' : x === '.' ? '<i class="sg-dot"></i>' : x ? segNum(x) : '').join('');
  function fit() { const k = Math.min(innerWidth / 1920, innerHeight / 1080); stage.style.transform = 'scale(' + k + ')'; stage.style.left = ((innerWidth - 1920 * k) / 2) + 'px'; stage.style.top = ((innerHeight - 1080 * k) / 2) + 'px'; }
  addEventListener('resize', fit); fit();
  if (!code || !key) { $('msg').textContent = 'Basketball overlay: open this from the DinkyKong OBS Monitor (missing match code / key).'; return; }

  let S = null, prevScore = null, prevPer = null, prevEnded = false, resetSeq = null, bannerId = null, shown = null, queue = [], qT = null, buzzed = null;
  const conn = PBB.connect({ code, key, autoReload: true, onSnap, onStatus: (s) => { $('msg').textContent = s === 'denied' ? 'Overlay link is not valid for this match.' : ''; } });

  /* ---------- static render ---------- */
  function teamOf(t) { return t === 'home' ? S.home : S.away; }
  function onSnap(s, last) {
    const first = !S; S = s;
    const b = s.broadcast || {}, c = s.config || {}, d = s.derived || {};
    const root = document.body;
    root.className = root.className.split(' ').filter((x) => /^(preview|photo|board|armed)$/.test(x)).join(' ');
    root.classList.add('theme-' + (b.theme || 'electric'), 'font-' + (b.font || 'digital'), 'pos-' + (b.pos || 'bottom'));
    if (b.names === 'full') root.classList.add('full');
    if (b.show_title || b.theme === 'tournament') root.classList.add('show-title');
    if (b.reduced_motion) root.classList.add('reduced');
    root.style.setProperty('--home', s.home.color); root.style.setProperty('--away', s.away.color);
    root.style.setProperty('--scale', b.scale || 1); root.style.setProperty('--dsz', b.digit_size || 1);
    // lower-third designer
    const nsz = Number(b.name_size) || 1, dsz = Number(b.digit_size) || 1;
    root.style.setProperty('--nsz', nsz); root.style.setProperty('--psz', Number(b.per_size) || Number(b.label_size) || 1); root.style.setProperty('--lsz', Number(b.label_size) || 1); root.style.setProperty('--rsz', Number(b.rb_size) || 1);
    // scoreboard height is its own setting now (bigger text no longer makes the bar taller)
    root.style.setProperty('--bhs', Number(b.bar_h) || 1); root.style.setProperty('--edge', b.edge == null ? 1 : Number(b.edge)); root.style.setProperty('--lgs', Number(b.logo_size) || 1); root.style.setProperty('--pps', 2 * (Number(b.pop_size) || 1));
    root.classList.add('rb-' + (['split', 'ribbon', 'stack', 'pill'].includes(b.rb_tpl) ? b.rb_tpl : 'split'));
    if (b.show_logos === false) root.classList.add('no-logos');
    const hex = (v) => /^#[0-9a-f]{6}$/i.test(v || '') ? v : '';
    const ink = (h) => { const n = parseInt(h.slice(1), 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)); return l > 150 ? '#05070c' : '#ffffff'; };
    const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };
    ['--rb-bg', '--rnd', '--rnd-ink', '--evt'].forEach((k) => root.style.removeProperty(k));
    if (hex(b.rb_bg)) root.style.setProperty('--rb-bg', rgba(b.rb_bg, b.opacity == null ? .94 : b.opacity));
    if (hex(b.rnd_color)) { root.style.setProperty('--rnd', b.rnd_color); root.style.setProperty('--rnd-ink', ink(b.rnd_color)); }
    if (hex(b.evt_color)) root.style.setProperty('--evt', b.evt_color); root.style.setProperty('--op', b.opacity == null ? .94 : b.opacity);
    { const op = b.opacity == null ? .94 : b.opacity, bc = /^#[0-9a-f]{6}$/i.test(b.bar_color || '') ? b.bar_color : '';
      if (bc) { const n = parseInt(bc.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, bl = n & 255, up = (x) => Math.min(255, Math.round(x + 18));
        root.style.setProperty('--glass', 'rgba(' + r + ',' + g + ',' + bl + ',' + op + ')'); root.style.setProperty('--glass2', 'rgba(' + up(r) + ',' + up(g) + ',' + up(bl) + ',' + op + ')'); root.classList.add('custom-bar'); }
      else { root.style.setProperty('--glass', 'rgba(10,13,22,' + op + ')'); root.style.setProperty('--glass2', 'rgba(22,27,40,' + op + ')'); } }
    $('wrap').classList.toggle('off', !BOARD && !!(s.overlay && s.overlay.hidden));
    // CATEGORY ROUND - EVENT / SEASON TITLE banner
    const rnd = String(b.round || '').trim(), evt = String(s.title || '').trim();
    // event logo: on the banner, or on its own in a top corner (tl / tr) with its own size
    const evLogo = /^data:image\//.test(b.rb_logo || '') ? b.rb_logo : '', corner = (b.logo_pos === 'tl' || b.logo_pos === 'tr') ? b.logo_pos : '';
    // a season game shows the season logo (looping WebM, transparent) in the corner; otherwise the event logo can sit there
    const ssn = s.season && b.season_logo !== false && (s.season.logo_anim || s.season.logo) ? s.season : null;
    const cl = $('cornerLogo');
    if (cl) {
      const pos = ssn ? (corner || 'tl') : corner, on = ssn || (corner && evLogo);
      cl.className = 'corner-logo' + (on ? ' on ' + pos : '');
      cl.style.setProperty('--cls', b.cl_size == null ? 1 : Number(b.cl_size));
      const key = ssn ? 's:' + (ssn.logo_anim || '') + '|' + (ssn.logo || '') : 'e:' + evLogo.length + evLogo.slice(-40);
      if (cl.dataset.k !== key) {
        cl.dataset.k = key;
        if (ssn && ssn.logo_anim) cl.innerHTML = '<video src="' + PBB.esc(ssn.logo_anim) + '"' + (ssn.logo ? ' poster="' + PBB.esc(ssn.logo) + '"' : '') + ' autoplay loop muted playsinline></video>';
        else { cl.innerHTML = '<img alt="">'; const src = ssn ? ssn.logo : evLogo; if (src) cl.querySelector('img').src = src; }
        const v = cl.querySelector('video'); if (v) { v.muted = true; const p = v.play(); p && p.catch && p.catch(() => {}); }
      }
    }
    const rb = $('rbn'), rbLogo = corner ? '' : evLogo, rbOn = b.show_round !== false && !!(rnd || evt || rbLogo);
    root.classList.toggle('show-round', !!rbOn);
    rb.classList.toggle('solo-r', !evt); rb.classList.toggle('solo-e', !rnd);
    rb.classList.toggle('has-logo', !!rbLogo); { const im = $('rbnL').querySelector('img'); if (rbLogo && im.getAttribute('src') !== rbLogo) im.src = rbLogo; }
    const rbTxt = rnd + '|' + evt + '|' + rbLogo.length;
    if (rbOn && rb.dataset.t !== rbTxt) { $('rbnR').textContent = rnd; $('rbnE').textContent = evt; rb.classList.remove('in'); void rb.offsetWidth; rb.classList.add('in'); rb.dataset.t = rbTxt; }
    $('ttl').innerHTML = s.title ? '<b>' + PBB.esc(s.title) + '</b>' + (s.venue ? ' · ' + PBB.esc(s.venue) : '') : 'DINKYKONG <b>LIVE</b>';
    ['home', 'away'].forEach((t) => {
      const T = teamOf(t), k = t === 'home' ? 'H' : 'A';
      $('n' + k).textContent = b.names === 'full' ? String(T.name || '').slice(0, BOARD ? 30 : 20) : (T.short || T.name);
      const lg = $('l' + k); lg.classList.toggle('none', !T.logo); if (T.logo) lg.querySelector('img').src = T.logo;
      $('f' + k).innerHTML = 'FOULS<i>' + ((d.fouls || {})[t] || 0) + '</i>'; $('f' + k).classList.toggle('hidden', b.show_fouls === false);
      $('p' + k).classList.toggle('on', !!(d.penalty || {})[t] && b.show_fouls !== false); $('p' + k).textContent = 'PENALTY';
      const tos = d.tos || {}, allow = Math.max(0, tos.allow || 0), used = tos[t] || 0;
      $('t' + k).innerHTML = b.show_tos === false ? '' : Array.from({ length: Math.min(allow, 8) }, (_, i) => '<i class="' + (i < allow - used ? '' : 'used') + '"></i>').join('');
      $('s' + k).classList.toggle('has-poss', b.show_poss !== false && d.poss === t);
      const sc = (d.score || {})[t] || 0, el = $('sc' + k);
      if (el.dataset.v !== String(sc)) {
        el.dataset.v = String(sc);
        if (BOARD) el.innerHTML = segNum(String(sc), 2); else el.textContent = sc;
        if (!first && prevScore && sc > prevScore[t]) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); const sd = $('s' + k); sd.classList.remove('flash'); void sd.offsetWidth; sd.classList.add('flash'); setTimeout(() => sd.classList.remove('flash'), 1000); }
      }
    });
    prevScore = Object.assign({}, d.score);
    // timer window
    const ext = c.timer_mode === 'external', mid = $('mid');
    mid.className = 'mid' + (ext ? ' ext ext-' + (b.timer_win === 'cutout' ? 'cutout' : 'black') : '') + (s.status === 'final' ? ' fin' : '');
    if (ext && !BOARD) { mid.style.width = (b.timer_w || 232) + 'px'; } else mid.style.width = '';
    // external timer window: bar matches the timer height, still scaled by the Scoreboard height slider
    $('bar').style.height = ext && b.timer_h && !BOARD ? Math.round(Math.max(70, b.timer_h) * (Number(b.bar_h) || 1)) + 'px' : '';
    $('per').textContent = s.status === 'final' ? 'FINAL' : PBB.periodLabel(d.period || 1, c.periods);
    // period start banner
    if (!first && prevPer != null && d.period !== prevPer && !(last && last.type === 'undo')) push({ kind: 'break', text: 'START OF ' + PBB.periodLabel(d.period, c.periods, true), hold: 3200, prio: 2 });
    prevPer = d.period;
    // overlay reset wipes any temporary graphic
    const rs = (s.overlay || {}).reset || 0;
    if (resetSeq != null && rs !== resetSeq) { queue = []; hideCard(true); }
    resetSeq = rs;
    // event pop-ups
    if (last && !first) onEvent(last);
    renderBanner();
  }

  /* ---------- live clock (60 fps, timestamp based) ---------- */
  let ac = null;
  function buzzer() {
    if (!S || S.config.buzzer === false) return;
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sawtooth'; o.frequency.value = 220; g.gain.setValueAtTime(.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(.25, ac.currentTime + .02);
      g.gain.setValueAtTime(.25, ac.currentTime + .9); g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + 1.1); o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 1.15); } catch (e) {}
  }
  function tick() {
    requestAnimationFrame(tick);
    if (!S) return;
    const now = conn.serverNow(), ck = S.clock || {}, c = S.config || {};
    const left = PBB.clockLeft(ck, now);
    const t = PBB.fmtClock(left, c.tenths !== false);
    const el = $('clk'); if (el.dataset.v !== t) { el.dataset.v = t; if (BOARD) el.innerHTML = segClock(t); else el.textContent = t; }
    el.classList.toggle('low', left < 60000 && left > 0);
    const ended = left === 0 && (ck.running || ck.ended);
    $('mid').classList.toggle('ended', ended);
    if (ended && !prevEnded && c.timer_mode !== 'external') {
      const key = (S.derived.period || 1) + ':' + ck.at;
      if (buzzed !== key) { buzzed = key; buzzer(); push({ kind: 'break', text: 'END OF ' + PBB.periodLabel(S.derived.period || 1, c.periods, true), hold: 4500, prio: 2 }); }
    }
    prevEnded = ended;
    const sh = ck.shot || {}, sEl = $('shot');
    if (c.shot_on === false || sh.hidden || c.timer_mode === 'external') { if (sEl.dataset.v !== '') { sEl.dataset.v = ''; sEl.textContent = ''; } }
    else { const sl = PBB.clockLeft(sh, now); const st = PBB.fmtShot(sl); if (sEl.dataset.v !== st) { sEl.dataset.v = st; if (BOARD) sEl.innerHTML = segNum(st, 2); else sEl.textContent = st; } sEl.classList.toggle('exp', sl === 0 && (sh.running || sh.expired)); }
    // banner countdown
    const cnt = document.querySelector('.card.in .cnt');
    if (cnt && shown && shown.until) { const s2 = Math.max(0, Math.ceil((shown.until - now) / 1000)); cnt.textContent = s2; if (s2 === 0 && shown.persistent) { shown.until = null; } }
  }
  requestAnimationFrame(tick);

  /* ---------- pop-up queue (priority, never touches the score data) ---------- */
  function playerById(id) { return (S.players || []).find((p) => p.id === id); }
  function onEvent(e) {
    const b = S.broadcast || {}, hold = Number(b.anim_ms) || 3000;
    if (e.type === 'score') {
      const p = playerById(e.player), T = teamOf(e.team);
      if (b.show_player === false) return;
      push({ kind: 'score', team: e.team, hold, prio: 1,
        jer: p ? p.number : (T.short || ''), name: p ? PBB.playerName(p) : T.name, sub: p ? (T.short || T.name) : 'TEAM POINTS',
        val: '+' + e.value, valTxt: e.value === 1 ? 'POINT' : 'POINTS', photo: p && p.photo, chips: p ? gameChips(p.id, e.value === 1 ? 'm1' : 'm' + e.value) : null });
    } else if (e.type === 'foul') {
      const p = playerById(e.player), T = teamOf(e.team), st = p ? S.derived.players[p.id] : null, kind = (e.data || {}).kind || 'P';
      const out = st && st.out;
      push({ kind: 'foul', team: e.team, hold, prio: 1, out,
        jer: p ? p.number : (T.short || ''), name: p ? PBB.playerName(p) : T.name + (kind === 'B' ? ' BENCH' : ''),
        sub: PBB.FOUL[kind] + (st ? ' (' + st.fouls + ')' : '') + (out ? (st.dq ? ' · DISQUALIFIED' : ' · FOULED OUT') : ''),
        val: String((S.derived.fouls || {})[e.team] || 0), valPre: 'TEAM', valTxt: (S.derived.penalty || {})[e.team] ? 'FOULS · PENALTY' : 'FOULS', photo: p && p.photo, chips: p ? gameChips(p.id, 'f') : null });
    } else if (e.type === 'sub') {
      const d = e.data || {}, ins = (d.in || []).map(playerById).filter(Boolean), outs = (d.out || []).map(playerById).filter(Boolean);
      if (b.show_player === false || !ins.length) return;
      push({ kind: 'sub', team: e.team, hold: Math.max(hold, 3500), prio: 1, ins, outs });
    }
  }
  // this game's numbers for one player: 2PT · 3PT · FT (made) · FOULS — the one that just changed glows
  function gameChips(id, hot) {
    const st = (S.derived.players || {})[id] || {};
    return [['m2', '2PT', st.m2], ['m3', '3PT', st.m3], ['m1', 'FT', st.m1], ['f', 'FOULS', st.fouls]].map(([k, l, v]) => ({ k, l, v: v || 0, hot: k === hot }));
  }
  function push(item) {
    if (S && S.broadcast && S.broadcast.reduced_motion) item.hold = Math.max(item.hold || 3000, 2500);
    // rapid scoring: drop older pending pop-ups of the same kind so the graphics never lag behind the game
    queue = queue.filter((x) => x.prio > item.prio || x.kind !== item.kind).concat(item).sort((a, b) => b.prio - a.prio).slice(-3);
    if (!qT) next();
  }
  function next() {
    clearTimeout(qT); qT = null;
    const banner = activeBanner();
    if (banner) { showCard(banner); return; }          // a held banner (timeout / break / final) has the stage
    const it = queue.shift();
    if (!it) { hideCard(); return; }
    showCard(it);
    qT = setTimeout(() => { qT = null; hideCard(); setTimeout(next, 380); }, it.hold || 3000);
  }
  function activeBanner() {
    const bn = S && S.overlay && S.overlay.banner;
    if (!bn) return null;
    if (bn.until && conn.serverNow() > bn.until + (bn.kind === 'timeout' ? 900 : 4000)) return null;   // countdown over: back to the scoreboard
    return { kind: 'banner', bid: bn.id, bkind: bn.kind, text: bn.text, sub: bn.sub, team: bn.team, until: bn.until, persistent: true };
  }
  function renderBanner() {
    const bn = activeBanner();
    const id = bn ? bn.bid + ':' + (S.status === 'final' ? 'f' + S.derived.score.home + '-' + S.derived.score.away : '') : null;
    if (id === bannerId) return;
    bannerId = id;
    if (bn) { clearTimeout(qT); qT = null; showCard(bn); }
    else if (shown && shown.persistent) { hideCard(); setTimeout(next, 380); }
  }
  setInterval(() => {   // banners with an end time (e.g. break with a duration) drop themselves
    if (!S) return; const bn = S.overlay && S.overlay.banner;
    if (bn && bn.until && conn.serverNow() > bn.until + (bn.kind === 'timeout' ? 900 : 4000) && shown && shown.persistent) { bannerId = null; hideCard(); setTimeout(next, 380); }
  }, 250);

  const cssUrl = (u) => "'" + String(u).replace(/['"\\\n<>]/g, '') + "'";
  let cardEl = null;
  function hideCard(instant) {
    shown = null; const el = cardEl; cardEl = null; if (!el) return;
    el.classList.remove('in'); setTimeout(() => el.remove(), instant ? 0 : 450);
  }
  function showCard(it) {
    if (cardEl) { const old = cardEl; old.classList.remove('in'); setTimeout(() => old.remove(), 300); }
    const el = document.createElement('div'); el.className = 'card ' + (it.kind === 'banner' ? 'banner' + (it.bkind === 'final' ? ' final' : '') : it.kind) + (it.out ? ' out' : '');
    const col = it.team ? (it.team === 'home' ? S.home.color : S.away.color) : 'var(--brand)';
    el.style.setProperty('--c', col);
    const E = PBB.esc;
    if (it.kind === 'banner' && it.bkind === 'final') {
      const h = S.derived.score.home, a = S.derived.score.away;
      el.innerHTML = '<div class="cacc" style="--c:var(--brand)"></div><div class="txt"><div class="fin-tag">FINAL</div><div class="fin">'
        + '<span class="' + (h >= a ? 'w' : 'l') + '" style="color:' + S.home.color + '">' + E(S.home.name) + '</span><span class="sc ' + (h >= a ? 'w' : 'l') + '">' + h + '</span>'
        + '<span style="opacity:.5">—</span><span class="sc ' + (a >= h ? 'w' : 'l') + '">' + a + '</span><span class="' + (a >= h ? 'w' : 'l') + '" style="color:' + S.away.color + '">' + E(S.away.name) + '</span></div></div>';
    } else if (it.kind === 'banner') {
      const T = it.team ? teamOf(it.team) : null;
      const big = it.bkind === 'timeout' ? 'TIMEOUT — ' + (T ? T.name : '') : it.text;
      el.innerHTML = '<div class="cacc"></div><div class="txt"><b>' + E(big) + '</b>' + (it.sub && it.bkind !== 'timeout' ? '<small>' + E(it.sub) + '</small>' : (it.bkind === 'timeout' ? '<small>' + E(PBB.periodLabel(S.derived.period, S.config.periods, true)) + ' · ' + ((S.derived.tos.allow || 0) - (S.derived.tos[it.team] || 0)) + ' LEFT</small>' : '')) + '</div>'
        + (it.until ? '<div class="cnt">' + Math.max(0, Math.ceil((it.until - conn.serverNow()) / 1000)) + '</div>' : '');
    } else if (it.kind === 'break') {
      el.className = 'card banner'; el.style.setProperty('--c', 'var(--brand)');
      el.innerHTML = '<div class="cacc"></div><div class="txt"><b>' + E(it.text) + '</b></div>';
    } else if (it.kind === 'sub') {
      const many = Math.max(it.ins.length, it.outs.length) > 2;
      el.classList.toggle('many', many);
      const T = teamOf(it.team);
      const pl = (p) => '<span class="sb-p"><i' + (p.photo ? ' class="pic" style="background-image:url(' + cssUrl(p.photo) + ')"' : '') + '>' + (p.photo ? '<b>' + E(p.number) + '</b>' : E(p.number)) + '</i><span>' + E(PBB.playerName(p, true)) + '</span></span>';
      el.innerHTML = '<div class="cacc"></div><div class="sb-tag"><small>SUBSTITUTION</small><b>' + E(T.short || T.name) + '</b></div><div class="sb-wrap">'
        + '<div class="sb-col sb-in"><span class="sb-h">▲ IN</span><div class="sb-l">' + it.ins.map(pl).join('') + '</div></div>'
        + '<div class="sb-col sb-out"><span class="sb-h">▼ OUT</span><div class="sb-l">' + it.outs.map(pl).join('') + '</div></div></div>';
    } else {
      const chips = it.chips ? '<div class="chips">' + it.chips.map((c) => '<span class="' + c.k + (c.hot ? ' hot' : '') + '">' + c.l + '<i>' + c.v + '</i></span>').join('') + '</div>' : '';
      if (it.photo) el.classList.add('has-ph');
      el.innerHTML = '<div class="cacc"></div>' + (it.photo ? '<div class="phx" style="background-image:url(' + cssUrl(it.photo) + ')"><b>' + E(it.jer) + '</b></div>' : '<div class="jer">' + E(it.jer) + '</div>')
        + '<div class="txt"><b>' + E(it.name) + '</b><small>' + E(it.sub) + '</small>' + chips + '</div>'
        + (it.valPre ? '<div class="val vf"><small class="vp">' + E(it.valPre) + '</small><span class="vn">' + E(it.val) + '<small>' + E(it.valTxt) + '</small></span></div>'
          : '<div class="val">' + E(it.val) + '<small>' + E(it.valTxt) + '</small></div>');
    }
    $('pop').appendChild(el); cardEl = el; shown = it;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }
  window.__bbObs = { get snap() { return S; }, conn };
})();
