/* Basketball LIVE OBS — broadcast overlay (OBS Browser Source, 1920×1080, transparent).
 * Read-only: it only knows the match code and the view key. */
(function () {
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const code = (q.get('m') || '').toUpperCase(), key = q.get('k') || '';
  if (q.get('preview')) document.body.classList.add('preview');
  if (q.get('preview') === 'photo') document.body.classList.add('photo');
  const stage = $('stage');
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
    root.className = root.className.split(' ').filter((x) => /^(preview|photo)$/.test(x)).join(' ');
    root.classList.add('theme-' + (b.theme || 'electric'), 'font-' + (b.font || 'digital'), 'pos-' + (b.pos || 'bottom'));
    if (b.names === 'full') root.classList.add('full');
    if (b.show_title || b.theme === 'tournament') root.classList.add('show-title');
    if (b.reduced_motion) root.classList.add('reduced');
    root.style.setProperty('--home', s.home.color); root.style.setProperty('--away', s.away.color);
    root.style.setProperty('--scale', b.scale || 1); root.style.setProperty('--dsz', b.digit_size || 1);
    // lower-third designer
    const nsz = Number(b.name_size) || 1, dsz = Number(b.digit_size) || 1;
    root.style.setProperty('--nsz', nsz); root.style.setProperty('--psz', Number(b.per_size) || Number(b.label_size) || 1); root.style.setProperty('--lsz', Number(b.label_size) || 1); root.style.setProperty('--rsz', Number(b.rb_size) || 1);
    root.style.setProperty('--bhs', Math.max(1, nsz * .95, dsz)); root.style.setProperty('--lgs', Number(b.logo_size) || 1);
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
    $('wrap').classList.toggle('off', !!(s.overlay && s.overlay.hidden));
    // CATEGORY ROUND - EVENT / SEASON TITLE banner
    const rnd = String(b.round || '').trim(), evt = String(s.title || '').trim();
    const rb = $('rbn'), rbLogo = /^data:image\//.test(b.rb_logo || '') ? b.rb_logo : '', rbOn = b.show_round !== false && !!(rnd || evt || rbLogo);
    root.classList.toggle('show-round', !!rbOn);
    rb.classList.toggle('solo-r', !evt); rb.classList.toggle('solo-e', !rnd);
    rb.classList.toggle('has-logo', !!rbLogo); { const im = $('rbnL').querySelector('img'); if (rbLogo && im.getAttribute('src') !== rbLogo) im.src = rbLogo; }
    const rbTxt = rnd + '|' + evt + '|' + rbLogo.length;
    if (rbOn && rb.dataset.t !== rbTxt) { $('rbnR').textContent = rnd; $('rbnE').textContent = evt; rb.classList.remove('in'); void rb.offsetWidth; rb.classList.add('in'); rb.dataset.t = rbTxt; }
    $('ttl').innerHTML = s.title ? '<b>' + PBB.esc(s.title) + '</b>' + (s.venue ? ' · ' + PBB.esc(s.venue) : '') : 'DINKYKONG <b>LIVE</b>';
    ['home', 'away'].forEach((t) => {
      const T = teamOf(t), k = t === 'home' ? 'H' : 'A';
      $('n' + k).textContent = b.names === 'full' ? String(T.name || '').slice(0, 15) : (T.short || T.name);
      const lg = $('l' + k); lg.classList.toggle('none', !T.logo); if (T.logo) lg.querySelector('img').src = T.logo;
      $('f' + k).innerHTML = 'FOULS<i>' + ((d.fouls || {})[t] || 0) + '</i>'; $('f' + k).classList.toggle('hidden', b.show_fouls === false);
      $('p' + k).classList.toggle('on', !!(d.penalty || {})[t] && b.show_fouls !== false); $('p' + k).textContent = 'PENALTY';
      const tos = d.tos || {}, allow = Math.max(0, tos.allow || 0), used = tos[t] || 0;
      $('t' + k).innerHTML = b.show_tos === false ? '' : Array.from({ length: Math.min(allow, 8) }, (_, i) => '<i class="' + (i < allow - used ? '' : 'used') + '"></i>').join('');
      $('s' + k).classList.toggle('has-poss', b.show_poss !== false && d.poss === t);
      const sc = (d.score || {})[t] || 0, el = $('sc' + k);
      if (el.textContent !== String(sc)) {
        el.textContent = sc;
        if (!first && prevScore && sc > prevScore[t]) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); const sd = $('s' + k); sd.classList.remove('flash'); void sd.offsetWidth; sd.classList.add('flash'); setTimeout(() => sd.classList.remove('flash'), 1000); }
      }
    });
    prevScore = Object.assign({}, d.score);
    // timer window
    const ext = c.timer_mode === 'external', mid = $('mid');
    mid.className = 'mid' + (ext ? ' ext ext-' + (b.timer_win === 'cutout' ? 'cutout' : 'black') : '') + (s.status === 'final' ? ' fin' : '');
    if (ext) { mid.style.width = (b.timer_w || 232) + 'px'; } else mid.style.width = '';
    $('bar').style.height = ext && b.timer_h ? Math.max(70, b.timer_h) + 'px' : '';
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
    const el = $('clk'); if (el.textContent !== t) el.textContent = t;
    el.classList.toggle('low', left < 60000 && left > 0);
    const ended = left === 0 && (ck.running || ck.ended);
    $('mid').classList.toggle('ended', ended);
    if (ended && !prevEnded && c.timer_mode !== 'external') {
      const key = (S.derived.period || 1) + ':' + ck.at;
      if (buzzed !== key) { buzzed = key; buzzer(); push({ kind: 'break', text: 'END OF ' + PBB.periodLabel(S.derived.period || 1, c.periods, true), hold: 4500, prio: 2 }); }
    }
    prevEnded = ended;
    const sh = ck.shot || {}, sEl = $('shot');
    if (c.shot_on === false || sh.hidden || c.timer_mode === 'external') { if (sEl.textContent) sEl.textContent = ''; }
    else { const sl = PBB.clockLeft(sh, now); const st = PBB.fmtShot(sl); if (sEl.textContent !== st) sEl.textContent = st; sEl.classList.toggle('exp', sl === 0 && (sh.running || sh.expired)); }
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
        jer: p ? p.number : (T.short || ''), name: p ? PBB.playerName(p) : T.name, sub: p ? (T.short || T.name) + (S.derived.players[p.id] ? ' · ' + S.derived.players[p.id].pts + ' PTS' : '') : 'TEAM POINTS',
        val: '+' + e.value, valTxt: e.value === 1 ? 'POINT' : 'POINTS', photo: p && p.photo });
    } else if (e.type === 'foul') {
      const p = playerById(e.player), T = teamOf(e.team), st = p ? S.derived.players[p.id] : null, kind = (e.data || {}).kind || 'P';
      const out = st && st.out;
      push({ kind: 'foul', team: e.team, hold, prio: 1, out,
        jer: p ? p.number : (T.short || ''), name: p ? PBB.playerName(p) : T.name + (kind === 'B' ? ' BENCH' : ''),
        sub: PBB.FOUL[kind] + (st ? ' (' + st.fouls + ')' : '') + (out ? (st.dq ? ' · DISQUALIFIED' : ' · FOULED OUT') : ''),
        val: 'TEAM ' + ((S.derived.fouls || {})[e.team] || 0), valTxt: (S.derived.penalty || {})[e.team] ? 'PENALTY' : 'FOULS', photo: p && p.photo });
    }
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
    if (bn.until && conn.serverNow() > bn.until + 4000 && bn.kind !== 'timeout') return null;
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
    if (bn && bn.until && bn.kind !== 'timeout' && conn.serverNow() > bn.until + 4000 && shown && shown.persistent) { bannerId = null; hideCard(); setTimeout(next, 380); }
  }, 1000);

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
    } else {
      el.innerHTML = '<div class="cacc"></div><div class="jer">' + E(it.jer) + '</div>' + (it.photo ? '<div class="ph" style="background-image:url(' + JSON.stringify(it.photo).slice(1, -1) + ')"></div>' : '')
        + '<div class="txt"><b>' + E(it.name) + '</b><small>' + E(it.sub) + '</small></div>'
        + '<div class="val">' + E(it.val) + '<small>' + E(it.valTxt) + '</small></div>';
    }
    $('pop').appendChild(el); cardEl = el; shown = it;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }
  window.__bbObs = { get snap() { return S; }, conn };
})();
