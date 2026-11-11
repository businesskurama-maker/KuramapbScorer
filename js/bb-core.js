/* DinkyKong · Basketball LIVE OBS — shared client core.
 * The server (Supabase functions bb_*) owns the match. Clients send actions with a unique event id and render
 * the authoritative snapshot that comes back (and that Realtime pushes to everyone on topic 'bb:<view_key>'). */
(function () {
  const cfg = window.PB_CONFIG || {};
  const SB_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
  ];
  let anon = null;
  async function client(signedIn) {
    if (signedIn && window.PBAuth) { await PBAuth.init(); if (PBAuth.client) return PBAuth.client; }
    await PBCommon.loadScript(SB_URLS);
    if (!anon) anon = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'dk-bb-anon' },
      realtime: { params: { eventsPerSecond: 20 } }
    });
    return anon;
  }

  const ERR = {
    NOT_PAIRED: 'This phone is not paired any more. Scan the QR code again.',
    REVOKED: 'The host removed this device. Scan the QR code again.',
    NOT_AUTHORIZED: 'Not allowed.', READ_ONLY: 'Read-only device.', CLOCK_ONLY: 'Clock operators can only run the clock.',
    NO_CLOCK_RIGHTS: 'The host turned off clock control for scorekeepers.', HOST_ONLY: 'Only the host can do that.',
    SETTINGS_LOCKED: 'Broadcast settings are locked by the host.', MATCH_FINAL: 'The match is final. The host can reopen it.',
    BAD_PLAYER: 'That player is not on this team.', NEGATIVE_SCORE: 'A score cannot go below zero.', NEGATIVE_STAT: 'That stat is already 0.',
    NO_TIMEOUTS_LEFT: 'No timeouts left in this period.', NOTHING_TO_UNDO: 'Nothing to undo.', NOTHING_TO_REDO: 'Nothing to redo.',
    CLOCK_AT_ZERO: 'The clock is at 0:00. Set the time or go to the next period.', COLORS_TOO_CLOSE: 'The two score colours are too similar. Pick clearly different colours.',
    DUPLICATE_JERSEY: 'That jersey number is already used on this team.', LIVE_PASS_REQUIRED: 'Your Basketball pass has ended. Donate or enter a pass code to create matches.', BAD_CODE: 'That pass code is not valid.', USED_CODE: 'That pass code was already used.', EXPIRED_CODE: 'That pass code expired.', BAD_REFERENCE: 'Enter the last 6 digits of the reference number.', DUPLICATE_REFERENCE: 'That reference number was already sent.', TOO_MANY_PENDING: 'You already have 3 donations waiting for confirmation.',
    SIGN_IN_REQUIRED: 'Sign in first.', NO_MATCH: 'Match not found.', PIN_LOCKED: 'Too many wrong PINs. Wait 10 minutes.',
    SCOREKEEPER_TAKEN: 'A scorekeeper is already connected. The host can allow more devices.', TEAM_NAME_REQUIRED: 'Both teams need a name.',
    TEXT_REQUIRED: 'Type the announcement first.', BAD_PERIOD: 'Invalid period.',
    NO_SEASON: 'Season not found.', SEASON_ENDED: 'This season has ended. Reopen it to make changes.', SEASON_TITLE_REQUIRED: 'Type a season title.',
    TITLE_MISMATCH: 'The title you typed does not match the season title.', OWNER_ONLY: 'Only the account that created the season can delete it.',
    ROSTER_FULL: 'This team already has 15 players.', TEAM_HAS_MATCHES: 'This team already played in a season match, so it cannot be removed.',
    SAME_TEAM: 'Pick two different teams.', TOO_MANY_TEAMS: 'A season can have up to 64 teams.', BAD_JERSEY: 'Jersey numbers are 0–99.',
    LINEUP_SIZE: 'Pick the right number of starters.', BAD_LINEUP: 'That lineup is not valid.', SUB_COUNT: 'Pick the same number of players going IN and OUT.',
    SUB_NOT_ON_COURT: 'A player going OUT is not on court any more. Refresh and try again.', SUB_ALREADY_ON: 'A player going IN is already on court.'
  };
  function errText(e) {
    const m = String((e && (e.message || e.msg)) || e || '');
    const k = Object.keys(ERR).find((x) => m.includes(x));
    if (k) return ERR[k];
    if (/fetch|network|Failed to|timeout/i.test(m)) return 'No connection. Check the internet.';
    return m.slice(0, 120) || 'Something went wrong.';
  }
  function errCode(e) { const m = String((e && e.message) || e || ''); return Object.keys(ERR).find((x) => m.includes(x)) || ''; }

  async function rpc(c, fn, args, ms) {
    const p = c.rpc(fn, args);
    const t = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || 12000));
    const { data, error } = await Promise.race([p, t]);
    if (error) throw new Error(error.message || String(error));
    return data;
  }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15); return (ch === 'x' ? r : (r & 3) | 8).toString(16);
  }));

  /* ---------- live match connection ----------
   * opts: { code, key (view key), token, signedIn, onSnap(snap, last), onStatus('live'|'connecting'|'offline') } */
  /* Self-healing live connection.
   * - Realtime push is the fast path; the HTTP snapshot is the fallback. If realtime dies (phone slept,
   *   Wi-Fi ⇄ data switch) the remote keeps working over HTTP polling while realtime reconnects.
   * - Every return to the page (unlock, tab switch, back online) re-checks and re-syncs immediately.
   * - opts.autoReload: if nothing works for ~45 s while the device says it's online, reload the page
   *   (pairing is stored, so the remote resumes by itself). */
  function connect(opts) {
    let c = null, ch = null, snap = null, offset = 0, status = 'connecting', closed = false, retryT = null, key = opts.key;
    let rtLive = false, httpOkAt = 0, denied = false, subAt = 0, hiddenAt = 0, badSince = Date.now(), creating = false, inflight = null;
    const POLL_OK = 7000;
    const setStatus = (s) => { if (s !== status) { status = s; opts.onStatus && opts.onStatus(s); } };
    function recompute() {
      if (closed) return;
      if (denied) { setStatus('denied'); return; }
      const ok = rtLive || (Date.now() - httpOkAt < POLL_OK);
      if (ok) badSince = 0; else if (!badSince) badSince = Date.now();
      setStatus(ok ? 'live' : (status === 'connecting' && Date.now() - (badSince || 0) < 8000 ? 'connecting' : 'offline'));
    }
    function apply(s, last) {
      if (!s || !s.code) return false;
      if (snap && s.version < snap.version) return false;          // stale push
      if (typeof s.now === 'number') offset = s.now - Date.now();
      const fresh = !snap || s.version !== snap.version;
      snap = s;
      if (fresh || last) opts.onSnap && opts.onSnap(s, last || null);
      return true;
    }
    async function ensureClient() {
      if (c || creating) return !!c;
      creating = true;
      try { c = await client(!!opts.signedIn); } catch (e) { opts.onError && opts.onError(e); } finally { creating = false; }
      return !!c;
    }
    function refresh() {                       // one snapshot at a time
      if (inflight) return inflight;
      inflight = (async () => {
        if (!(await ensureClient())) { recompute(); return false; }
        try {
          const s = await rpc(c, 'bb_snapshot', { p_code: opts.code, p_key: key || null, p_token: opts.token || null });
          httpOkAt = Date.now(); denied = false; apply(s, null); recompute(); return true;
        } catch (e) {
          if (/NOT_PAIRED|REVOKED|NO_MATCH/.test(String(e.message))) denied = true;
          opts.onError && opts.onError(e); recompute(); return false;
        }
      })().finally(() => { inflight = null; });
      return inflight;
    }
    function subscribe() {
      if (!key || closed || !c) return;
      clearTimeout(retryT);
      if (ch) { const old = ch; ch = null; try { c.removeChannel(old); } catch (e) {} }
      rtLive = false; subAt = Date.now();
      try { const st = c.realtime && c.realtime.connectionState && c.realtime.connectionState(); if (st === 'closed' || st === 'closing') c.realtime.connect(); } catch (e) {}
      const me = c.channel('bb:' + key, { config: { broadcast: { self: false, ack: false } } });   // fresh channel object every time
      ch = me;
      me.on('broadcast', { event: 'state' }, (e) => {
        const p = e.payload || {}; const last = p.last || null; delete p.last;
        rtLive = true; apply(p, last); recompute();
      });
      me.subscribe((st) => {
        if (ch !== me) return;                 // replaced
        if (st === 'SUBSCRIBED') { rtLive = true; recompute(); refresh(); }   // re-sync after every (re)connect
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
          rtLive = false; recompute(); refresh();
          clearTimeout(retryT); retryT = setTimeout(() => { if (!closed) subscribe(); }, 3000);
        }
      });
    }
    // come back from sleep / background / network change: check right away
    function kick(force) {
      if (closed) return;
      refresh().then(() => {
        const sock = c && c.realtime && c.realtime.connectionState ? c.realtime.connectionState() : 'open';
        if (force || !rtLive || sock !== 'open') subscribe();
      });
    }
    (async () => { await ensureClient(); if (!key) await refresh(); subscribe(); if (key) refresh(); })().catch((e) => { recompute(); opts.onError && opts.onError(e); });

    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
      kick(away > 15000);                      // long sleep: sockets are usually dead, rebuild the channel
    };
    const onOnline = () => kick(true), onOffline = () => { rtLive = false; httpOkAt = 0; recompute(); };
    const onShow = (e) => kick(!!(e && e.persisted)), onFocus = () => { if (status !== 'live') kick(false); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    window.addEventListener('pageshow', onShow); window.addEventListener('focus', onFocus);
    // watchdog: poll while realtime is down, re-subscribe if stuck, reload as a last resort
    let tick = 0;
    const wd = setInterval(() => {
      if (closed || document.visibilityState !== 'visible') return;
      tick++;
      if (!c) { ensureClient().then((ok) => ok && subscribe()); return; }
      if (!rtLive) {
        refresh();                                            // HTTP keeps the remote usable
        if (Date.now() - subAt > 10000) subscribe();          // channel never came up: rebuild it
      } else if (tick % 5 === 0) refresh();                   // live: light re-sync every ~10 s
      recompute();
      if (opts.autoReload && status === 'offline' && badSince && Date.now() - badSince > 45000 && navigator.onLine !== false) {
        let lastR = 0; try { lastR = Number(sessionStorage.getItem('dk.bb.reload') || 0); } catch (e) {}
        if (Date.now() - lastR > 120000) { try { sessionStorage.setItem('dk.bb.reload', String(Date.now())); } catch (e) {} location.reload(); }
      }
    }, 2000);

    return {
      get snap() { return snap; }, get status() { return status; }, get offset() { return offset; },
      serverNow: () => Date.now() + offset,
      setKey(k) { if (k && k !== key) { key = k; subscribe(); } },
      refresh, apply, kick,
      async act(type, data, id) {
        if (status !== 'live') { await refresh(); if (status !== 'live') { kick(true); throw new Error('OFFLINE'); } }
        const s = await rpc(c, 'bb_act', { p_code: opts.code, p_token: opts.token || null, p_id: id || uuid(), p_type: type, p_data: data || {} });
        httpOkAt = Date.now(); const last = s.last; delete s.last; apply(s, last); recompute(); return s;
      },
      async events() { return rpc(c, 'bb_events', { p_code: opts.code, p_key: key || null, p_token: opts.token || null }); },
      close() {
        closed = true; clearInterval(wd); clearTimeout(retryT);
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
        window.removeEventListener('pageshow', onShow); window.removeEventListener('focus', onFocus);
        try { ch && c.removeChannel(ch); } catch (e) {}
      }
    };
  }

  /* ---------- helpers ---------- */
  function clockLeft(ck, serverNow) {
    if (!ck) return 0;
    const ms = Number(ck.ms) || 0;
    return Math.max(0, ck.running ? ms - (serverNow - (Number(ck.at) || serverNow)) : ms);
  }
  function fmtClock(ms, tenths) {
    ms = Math.max(0, ms);
    if (tenths && ms < 60000) { const s = Math.floor(ms / 1000), t = Math.floor((ms % 1000) / 100); return s + '.' + t; }
    const tot = Math.ceil(ms / 1000), m = Math.floor(tot / 60), s = tot % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtShot(ms) { ms = Math.max(0, ms); return ms < 5000 && ms > 0 ? (ms / 1000).toFixed(1) : String(Math.ceil(ms / 1000)); }
  function periodLabel(p, periods, long) {
    periods = periods || 4;
    if (p > periods) { const n = p - periods; return long ? (n === 1 ? 'OVERTIME' : 'OVERTIME ' + n) : (n === 1 ? 'OT' : 'OT' + n); }
    if (long) return ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'][p - 1] + (periods === 2 ? ' HALF' : ' QUARTER');
    return (periods === 2 ? 'H' : 'Q') + p;
  }
  function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function colorDist(a, b) { const x = hexRgb(a), y = hexRgb(b); if (!x || !y) return 999; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
  const MIN_DIST = 110;
  const ELECTRIC = ['#00e5ff', '#39ff14', '#ff2e4d', '#ffd400', '#b26bff', '#ff7a00', '#ff3df5', '#2f7bff', '#ffffff'];
  function playerName(p, short) {
    if (!p) return '';
    if (short) return p.display || ((p.first ? p.first[0] + '. ' : '') + (p.last || '')).trim() || ('#' + p.number);
    return ((p.first || '') + ' ' + (p.last || '')).trim() || p.display || ('#' + p.number);
  }
  const FOUL = { P: 'PERSONAL FOUL', T: 'TECHNICAL FOUL', U: 'UNSPORTSMANLIKE FOUL', D: 'DISQUALIFYING FOUL', B: 'BENCH TECHNICAL' };
  const FOUL_SHORT = { P: 'Personal', T: 'Technical', U: 'Unsportsmanlike', D: 'Disqualifying', B: 'Bench tech' };
  const BREAKS = [
    ['PRE-GAME', 'Coverage begins shortly'], ['TIP-OFF', ''], ['END OF 1ST QUARTER', ''], ['END OF 2ND QUARTER', ''], ['HALFTIME', ''],
    ['END OF 3RD QUARTER', ''], ['END OF REGULATION', ''], ['OVERTIME', ''], ['OFFICIAL REVIEW', 'Play is under review'], ['GAME PAUSED', 'Play will resume shortly'], ['FINAL SCORE', '']
  ];
  const PRESETS = {
    basic: { label: 'Basic OBS', basic: true, periods: 4, period_min: 10, ot_min: 5, shot_on: false, shot_full: 24, shot_short: 14, pf_limit: 5, fiba_dq: true, tf_limit: 4, tf_reset: 'period', tf_ot_continues: true, to_mode: 'game', to_game: 9, to_ot: 3, to_secs: 60 },
    fiba: { label: 'FIBA', periods: 4, period_min: 10, ot_min: 5, shot_on: true, shot_full: 24, shot_short: 14, pf_limit: 5, fiba_dq: true, tf_limit: 4, tf_reset: 'period', tf_ot_continues: true, to_mode: 'halves', to_h1: 2, to_h2: 3, to_ot: 1, to_secs: 60 },
    nba: { label: 'NBA style', periods: 4, period_min: 12, ot_min: 5, shot_on: true, shot_full: 24, shot_short: 14, pf_limit: 6, fiba_dq: false, tf_limit: 5, tf_reset: 'period', tf_ot_continues: false, to_mode: 'game', to_game: 7, to_ot: 2, to_secs: 75 },
    ncaa: { label: 'College halves', periods: 2, period_min: 20, ot_min: 5, shot_on: true, shot_full: 30, shot_short: 20, pf_limit: 5, fiba_dq: false, tf_limit: 7, tf_reset: 'half', tf_ot_continues: true, to_mode: 'game', to_game: 4, to_ot: 1, to_secs: 60 },
    league: { label: 'Barangay league', periods: 4, period_min: 10, ot_min: 5, shot_on: false, shot_full: 24, shot_short: 14, pf_limit: 5, fiba_dq: true, tf_limit: 4, tf_reset: 'period', tf_ot_continues: true, to_mode: 'halves', to_h1: 2, to_h2: 3, to_ot: 1, to_secs: 60 }
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // resize an image file to a square-ish PNG data URL (logos / photos)
  function imageToData(file, max) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { const im = new Image(); im.onload = () => {
        const k = Math.min(1, (max || 256) / Math.max(im.width, im.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); res(cv.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', .86));
      }; im.onerror = rej; im.src = r.result; };
      r.onerror = rej; r.readAsDataURL(file);
    });
  }

  /* ---------- logo cropper: zoom / move / fit into a rounded square → WebP ≤ 50 KB ---------- */
  function cropLogo(file, opts) {
    opts = opts || {};
    const MAXB = opts.maxBytes || 50 * 1024;
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onerror = () => reject(new Error('Could not read that image'));
      rd.onload = () => {
        const im = new Image();
        im.onerror = () => reject(new Error('That file is not an image'));
        im.onload = () => openUI(im);
        im.src = rd.result;
      };
      rd.readAsDataURL(file);
      function openUI(im) {
        const V = 280;   // editor viewport (css px)
        const m = document.createElement('div'); m.className = 'modal crop-modal';
        m.innerHTML = '<div class="sheet crop-sheet"><h3>Adjust logo</h3><div class="tiny">Drag to move · pinch, scroll or use the slider to zoom. The logo is saved as a rounded square.</div>'
          + '<div class="crop-stage"><canvas width="' + V * 2 + '" height="' + V * 2 + '"></canvas><div class="crop-mask"></div></div>'
          + '<input type="range" class="crop-zoom" min="0" max="1" step="0.001" value="0">'
          + '<div class="crop-row"><button class="btn sm" data-a="fit">Fit</button><button class="btn sm" data-a="fill">Fill</button><button class="btn sm" data-a="center">Center</button><button class="btn sm" data-a="rot">Rotate</button></div>'
          + '<div class="crop-row"><span class="tiny">Background</span><button class="crop-bg on" data-bg="" title="Transparent"></button><button class="crop-bg" data-bg="#ffffff" style="background:#fff"></button><button class="crop-bg" data-bg="#0b1026" style="background:#0b1026"></button><button class="crop-bg" data-bg="#000000" style="background:#000"></button></div>'
          + '<div class="g2"><button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="ok">Use logo</button></div><div class="tiny crop-info"></div></div>';
        document.body.appendChild(m);
        const cv = m.querySelector('canvas'), g = cv.getContext('2d'), zoomEl = m.querySelector('.crop-zoom');
        let rot = 0, bg = '', x = 0, y = 0, sc = 1;
        const dims = () => (rot % 180 ? [im.height, im.width] : [im.width, im.height]);
        const fitS = () => { const [w, h] = dims(); return V / Math.max(w, h); }, fillS = () => { const [w, h] = dims(); return V / Math.min(w, h); };
        const minS = () => fitS() * 0.5, maxS = () => fillS() * 4;
        const setZoomFromScale = () => { zoomEl.value = Math.log(sc / minS()) / Math.log(maxS() / minS()); };
        const setScale = (s2, cx, cy) => { s2 = Math.max(minS(), Math.min(maxS(), s2)); cx = cx == null ? V / 2 : cx; cy = cy == null ? V / 2 : cy; x = cx - (cx - x) * (s2 / sc); y = cy - (cy - y) * (s2 / sc); sc = s2; setZoomFromScale(); draw(); };
        function reset(mode) { const [w, h] = dims(); sc = mode === 'fill' ? fillS() : fitS(); x = (V - w * sc) / 2; y = (V - h * sc) / 2; setZoomFromScale(); draw(); }
        function paint(ctx, size) {
          const k = size / V; ctx.clearRect(0, 0, size, size);
          ctx.save();
          const r = size * 0.22; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(0, 0, size, size, r); else ctx.rect(0, 0, size, size); ctx.clip();
          if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size); }
          const [w, h] = dims();
          ctx.translate((x + w * sc / 2) * k, (y + h * sc / 2) * k); ctx.rotate(rot * Math.PI / 180);
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(im, -im.width * sc * k / 2, -im.height * sc * k / 2, im.width * sc * k, im.height * sc * k);
          ctx.restore();
        }
        function draw() { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
          // faint full image outside the crop for orientation
          g.save(); g.globalAlpha = .25; const [w, h] = dims(); g.translate((x + w * sc / 2) * 2, (y + h * sc / 2) * 2); g.rotate(rot * Math.PI / 180); g.drawImage(im, -im.width * sc, -im.height * sc, im.width * sc * 2, im.height * sc * 2); g.restore();
          const tmp = document.createElement('canvas'); tmp.width = tmp.height = V * 2; paint(tmp.getContext('2d'), V * 2); g.drawImage(tmp, 0, 0); }
        zoomEl.oninput = () => { const t = Number(zoomEl.value); const s2 = minS() * Math.pow(maxS() / minS(), t); const ns = sc; sc = ns; setScale(s2); };
        // drag / pinch
        const pts = new Map(); let last = null, pinch = null;
        const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * V / r.width, (e.clientY - r.top) * V / r.height]; };
        cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, pos(e)); last = pos(e); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: sc }; } });
        cv.addEventListener('pointermove', (e) => {
          if (!pts.has(e.pointerId)) return; const p = pos(e); pts.set(e.pointerId, p);
          if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); setScale(pinch.s * d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
          else if (last) { x += p[0] - last[0]; y += p[1] - last[1]; last = p; draw(); }
        });
        const up = (e) => { pts.delete(e.pointerId); pinch = null; last = pts.size ? [...pts.values()][0] : null; };
        cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
        cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e); setScale(sc * Math.exp(-e.deltaY * 0.0015), p[0], p[1]); }, { passive: false });
        m.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-a],[data-bg]'); if (!b) return;
          if (b.dataset.bg != null) { bg = b.dataset.bg; m.querySelectorAll('.crop-bg').forEach((x2) => x2.classList.toggle('on', x2 === b)); draw(); return; }
          const a = b.dataset.a;
          if (a === 'fit') reset('fit'); if (a === 'fill') reset('fill');
          if (a === 'center') { const [w, h] = dims(); x = (V - w * sc) / 2; y = (V - h * sc) / 2; draw(); }
          if (a === 'rot') { rot = (rot + 90) % 360; reset('fit'); }
          if (a === 'cancel') { m.remove(); reject(new Error('CANCELLED')); }
          if (a === 'ok') {
            const out = await encode(); if (!out) { m.querySelector('.crop-info').textContent = 'Could not make the logo small enough. Try zooming in or a simpler image.'; return; }
            m.remove(); resolve(out);
          }
        });
        async function encode() {
          const kb = (d) => Math.round(d.length * 0.75 / 1024);
          for (const size of [256, 224, 192, 160, 128]) {
            const c = document.createElement('canvas'); c.width = c.height = size; paint(c.getContext('2d'), size);
            for (const q of [0.92, 0.85, 0.78, 0.7, 0.6, 0.5, 0.4]) {
              let d = c.toDataURL('image/webp', q);
              if (!d.startsWith('data:image/webp')) {   // Safari can't encode WebP: PNG keeps transparency, JPEG as last resort
                d = c.toDataURL('image/png'); if (d.length * 0.75 > MAXB) { const j = document.createElement('canvas'); j.width = j.height = size; const jg = j.getContext('2d'); jg.fillStyle = bg || '#0b1026'; jg.fillRect(0, 0, size, size); jg.drawImage(c, 0, 0); d = j.toDataURL('image/jpeg', q); }
              }
              if (d.length * 0.75 <= MAXB) { m.querySelector('.crop-info').textContent = size + '×' + size + ' · ' + kb(d) + ' KB'; return d; }
            }
          }
          return null;
        }
        reset('fit');
      }
    });
  }


  /* ---------- Lower-third designer (shared by the phone remote and the portal's OBS Monitor) ----------
   * el: container; getB(): current broadcast settings; send(patch): saves a broadcast patch. */
  const LOOK_TPL = [['split', 'Split', 'Category tab + title'], ['ribbon', 'Ribbon', 'One coloured ribbon'], ['stack', 'Stacked', 'Small category, big title'], ['pill', 'Pill', 'Compact floating pill']];
  const LOOK_SL = [['scale', 'Overall size', 0.6, 1.5], ['bar_h', 'Scoreboard height', 0.7, 1.4], ['edge', 'Distance from screen edge', 0, 2.5], ['rb_size', 'Category / title banner', 0.6, 1.8], ['name_size', 'Team names', 0.7, 1.5],
    ['label_size', 'Labels (fouls, period, tabs)', 0.7, 1.6], ['digit_size', 'Numbers (score, clock)', 0.7, 1.4], ['per_size', 'Quarter / period status', 0.7, 2], ['logo_size', 'Team logos', 0.6, 1.3]];
  const LOOK_COL = [['rb_bg', 'Banner', '#0a0d16'], ['rnd_color', 'Category', '#39ff14'], ['evt_color', 'Event title', '#f4f6fb'], ['bar_color', 'Scoreboard', '#0a0d16']];
  const LOOK_KEYS = ['rb_tpl', 'show_logos', 'rb_logo', 'logo_pos', 'cl_size', 'season_logo'].concat(LOOK_SL.map((x) => x[0]), LOOK_COL.map((x) => x[0]));
  function lookPanel(el, getB, send) {
    el.innerHTML = '<div class="seg seg-sm lk-tabs"><button type="button" data-lt="tpl" class="on">Template</button><button type="button" data-lt="size">Size</button><button type="button" data-lt="col">Colour</button><button type="button" data-lt="logo">Logo</button></div>'
      + '<div class="lk-pane" data-lp="tpl"><div class="lk-tpl">' + LOOK_TPL.map(([k, l, d]) => '<button type="button" data-tpl="' + k + '"><i class="lk-ic lk-' + k + '"><b></b><s></s></i><b>' + l + '</b><small>' + d + '</small></button>').join('') + '</div>'
      + '<div class="lk-nm"><span><b>Team names</b><small>On the scoreboard</small></span><div class="seg seg-sm" data-nmseg><button type="button" data-nm="short">Initials</button><button type="button" data-nm="full">Full name (max 20)</button></div></div></div>'
      + '<div class="lk-pane hidden" data-lp="size"><div class="lk-sl">' + LOOK_SL.map(([k, l, a, z]) => '<label class="lk-r"><span>' + l + '<em data-v="' + k + '">100%</em></span><input type="range" min="' + a + '" max="' + z + '" step="0.05" data-lk="' + k + '"></label>').join('') + '</div></div>'
      + '<div class="lk-pane hidden" data-lp="col"><div class="lk-col">' + LOOK_COL.map(([k, l, d]) => '<label class="lk-c"><input type="color" data-lc="' + k + '" value="' + d + '"><span>' + l + '<small data-cv="' + k + '">Auto</small></span><button type="button" class="lk-x" data-cx="' + k + '" title="Back to theme colour">↺</button></label>').join('') + '</div></div>'
      + '<div class="lk-pane hidden" data-lp="logo"><div class="lk-logo"><span class="lk-lth" data-lth></span><span class="lk-lt"><b>Event logo</b><small>Optional · league or tournament logo</small></span>'
      + '<label class="btn sm">Upload<input type="file" accept="image/*" hidden data-rblogo></label><button type="button" class="btn sm ghost" data-rbx>Remove</button></div>'
      + '<div class="lk-nm"><span><b>Logo position</b><small>On the banner, or alone in a top corner</small></span><div class="seg seg-sm"><button type="button" data-lpos="banner">On banner</button><button type="button" data-lpos="tl">Top left</button><button type="button" data-lpos="tr">Top right</button></div></div>'
      + '<label class="lk-t"><input type="checkbox" data-slg> Season logo in the top corner <span class="tiny">(season games · animated WebM)</span></label>'
      + '<label class="lk-r lk-cl"><span>Corner logo size<em data-v="cl_size">100%</em></span><input type="range" min="0.4" max="2.5" step="0.05" data-lk="cl_size"></label>'
      + '<label class="lk-t lk-tl"><input type="checkbox" data-lg> Show team logos beside team names</label><p class="tiny" style="margin:6px 0 0">Team logos are uploaded in Match setup → Teams &amp; rosters.</p></div>'
      + '<div class="lk-foot"><span class="tiny">Saved when you let go of a slider or pick a colour.</span><button type="button" class="btn sm ghost" data-lreset>Reset look</button></div>';
    const pct = (v) => Math.round(v * 100) + '%';
    function paint() {
      const b = getB() || {};
      el.querySelectorAll('[data-tpl]').forEach((x) => x.classList.toggle('on', x.dataset.tpl === (b.rb_tpl || 'split')));
      el.querySelectorAll('[data-lpos]').forEach((x) => x.classList.toggle('on', x.dataset.lpos === (b.logo_pos || 'banner')));
      el.querySelector('.lk-cl').classList.toggle('dim', !(b.logo_pos === 'tl' || b.logo_pos === 'tr') && b.season_logo === false);
      el.querySelector('[data-slg]').checked = b.season_logo !== false;
      el.querySelectorAll('[data-nm]').forEach((x) => x.classList.toggle('on', x.dataset.nm === (b.names === 'full' ? 'full' : 'short')));
      el.querySelectorAll('[data-lk]').forEach((x) => { if (document.activeElement === x && x._drag) return; const v = b[x.dataset.lk] == null || b[x.dataset.lk] === '' ? 1 : Number(b[x.dataset.lk]); x.value = v; el.querySelector('[data-v="' + x.dataset.lk + '"]').textContent = pct(v); });
      LOOK_COL.forEach(([k, , d]) => { const v = /^#[0-9a-f]{6}$/i.test(b[k] || '') ? b[k] : ''; const inp = el.querySelector('[data-lc="' + k + '"]'); if (document.activeElement !== inp) inp.value = v || d; el.querySelector('[data-cv="' + k + '"]').textContent = v ? v.toUpperCase() : 'Theme'; el.querySelector('[data-cx="' + k + '"]').classList.toggle('hidden', !v); });
      el.querySelector('[data-lg]').checked = b.show_logos !== false;
      const lg = /^data:image\//.test(b.rb_logo || '') ? b.rb_logo : '';
      el.querySelector('[data-lth]').innerHTML = lg ? '<img src="' + lg + '" alt="">' : '🏆';
      el.querySelector('[data-rbx]').classList.toggle('hidden', !lg);
    }
    el.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-lt]'); if (tb) { el.querySelectorAll('[data-lt]').forEach((x) => x.classList.toggle('on', x === tb)); el.querySelectorAll('[data-lp]').forEach((x) => x.classList.toggle('hidden', x.dataset.lp !== tb.dataset.lt)); return; }
      const lp = e.target.closest('[data-lpos]'); if (lp) { send({ logo_pos: lp.dataset.lpos }); return; }
      const nm = e.target.closest('[data-nm]'); if (nm) { send({ names: nm.dataset.nm }); return; }
      const t = e.target.closest('[data-tpl]'); if (t) { send({ rb_tpl: t.dataset.tpl }); return; }
      const x = e.target.closest('[data-cx]'); if (x) { e.preventDefault(); send({ [x.dataset.cx]: null }); return; }
      if (e.target.closest('[data-rbx]')) { send({ rb_logo: null }); return; }
      if (e.target.closest('[data-lreset]')) { const p = {}; LOOK_KEYS.forEach((k) => { if (k !== 'rb_logo') p[k] = null; }); send(p); }
    });
    el.addEventListener('input', (e) => { const r = e.target.closest('[data-lk]'); if (r) { r._drag = true; el.querySelector('[data-v="' + r.dataset.lk + '"]').textContent = pct(Number(r.value)); } });
    el.addEventListener('change', (e) => {
      const r = e.target.closest('[data-lk]'); if (r) { r._drag = false; send({ [r.dataset.lk]: Number(r.value) }); return; }
      const c = e.target.closest('[data-lc]'); if (c) { send({ [c.dataset.lc]: c.value }); return; }
      if (e.target.matches('[data-lg]')) { send({ show_logos: e.target.checked }); return; }
      if (e.target.matches('[data-slg]')) { send({ season_logo: e.target.checked }); return; }
      if (e.target.matches('[data-rblogo]') && e.target.files[0]) {
        const f = e.target.files[0]; e.target.value = '';
        cropLogo(f).then((d) => send({ rb_logo: d })).catch((x) => { if (x && x.message !== 'CANCELLED') alert(x.message || 'Could not read that image'); });
      }
    });
    paint();
    return { paint };
  }

  /* ---------- media for seasons: WebP images (≤ 500 KB), animated logo → WebM, uploads to Supabase Storage ---------- */
  const loadImg = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That file is not an image')); im.src = src; });
  const canvasBlob = (cv, type, q) => new Promise((res) => cv.toBlob(res, type, q));
  // draws src (image / video / frame) centre-cropped to a square (fit:'cover') or letter-boxed (fit:'contain')
  function drawSquare(g, src, w, h, size, fit) {
    const k = fit === 'contain' ? size / Math.max(w, h) : size / Math.min(w, h);
    const dw = w * k, dh = h * k;
    g.clearRect(0, 0, size, size); g.imageSmoothingQuality = 'high';
    g.drawImage(src, (size - dw) / 2, fit === 'top' ? 0 : (size - dh) / 2, dw, dh);
  }
  // any image file → square WebP Blob ≤ maxBytes (default 500 KB). fit 'top' keeps faces (photos) in frame.
  async function toWebp(file, opts) {
    opts = opts || {};
    const maxB = opts.maxBytes || 500 * 1024, url = URL.createObjectURL(file);
    try {
      const im = await loadImg(url);
      for (const size of opts.sizes || [512, 448, 384, 320, 256]) {
        const cv = document.createElement('canvas'); cv.width = cv.height = size;
        drawSquare(cv.getContext('2d'), im, im.naturalWidth, im.naturalHeight, size, opts.fit || 'cover');
        for (const q of [0.9, 0.82, 0.74, 0.65, 0.55]) {
          const b = await canvasBlob(cv, 'image/webp', q);
          if (b && b.type === 'image/webp' && b.size <= maxB) return b;
          if (b && b.type !== 'image/webp') { const p = await canvasBlob(cv, 'image/png'); if (p && p.size <= maxB) return p; break; }   // Safari: no WebP encoder
        }
      }
      throw new Error('Could not make that image small enough');
    } finally { URL.revokeObjectURL(url); }
  }
  /* Season logo: a square image, GIF or short video.
   * → { poster: WebP Blob, anim: WebM Blob | null, secs }  (WebM keeps transparency, 320 px, ≤ 6 s, loops on OBS) */
  async function seasonLogo(file, onProgress) {
    const prog = onProgress || (() => {});
    const isVid = /^video\//.test(file.type), isGif = file.type === 'image/gif';
    if (!isVid && !isGif) return { poster: await toWebp(file, { maxBytes: 300 * 1024, fit: 'contain' }), anim: null };
    const SIZE = 320, MAXS = 6;
    const cv = document.createElement('canvas'); cv.width = cv.height = SIZE; const g = cv.getContext('2d');
    const canRec = typeof MediaRecorder !== 'undefined' && cv.captureStream && MediaRecorder.isTypeSupported('video/webm;codecs=vp8');
    let poster = null;
    const grabPoster = async () => { if (!poster) poster = await canvasBlob(cv, 'image/webp', 0.85); };
    const url = URL.createObjectURL(file);
    try {
      let rec = null, chunks = [];
      const startRec = () => { if (!canRec) return; const st = cv.captureStream(25); rec = new MediaRecorder(st, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 650000 }); rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data); rec.start(250); };
      const stopRec = () => new Promise((res) => { if (!rec) return res(null); rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' })); rec.stop(); });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let secs = 0;
      if (isVid) {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = url; v.crossOrigin = 'anonymous';
        await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('That video cannot be played in this browser')); });
        secs = Math.min(MAXS, v.duration || MAXS);
        drawSquare(g, v, v.videoWidth, v.videoHeight, SIZE, 'contain'); await grabPoster();
        if (canRec) {
          startRec(); await v.play();
          await new Promise((res) => { const t0 = performance.now(); (function f() { drawSquare(g, v, v.videoWidth, v.videoHeight, SIZE, 'contain'); const el = (performance.now() - t0) / 1000; prog(Math.min(1, el / secs)); if (el >= secs || v.ended) res(); else requestAnimationFrame(f); })(); });
          v.pause();
        }
      } else if (typeof ImageDecoder !== 'undefined') {
        const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
        await dec.tracks.ready; const n = Math.max(1, dec.tracks.selectedTrack.frameCount);
        const frames = [];
        for (let i = 0; i < n && frames.reduce((a, b) => a + b.d, 0) < MAXS * 1000; i++) { const r = await dec.decode({ frameIndex: i }); frames.push({ img: r.image, d: Math.max(20, (r.image.duration || 100000) / 1000) }); }
        const tot = frames.reduce((a, b) => a + b.d, 0); secs = Math.min(MAXS, tot / 1000);
        const fw = frames[0].img.displayWidth, fh = frames[0].img.displayHeight;
        drawSquare(g, frames[0].img, fw, fh, SIZE, 'contain'); await grabPoster();
        if (canRec && frames.length > 1) {
          startRec(); let el = 0;
          for (const fr of frames) { drawSquare(g, fr.img, fw, fh, SIZE, 'contain'); await wait(fr.d); el += fr.d; prog(Math.min(1, el / tot)); }
        }
        frames.forEach((f) => f.img.close && f.img.close()); dec.close && dec.close();
      } else {   // older browsers: let the <img> animate and sample it for 3 s
        const im = await loadImg(url); secs = 3;
        drawSquare(g, im, im.naturalWidth, im.naturalHeight, SIZE, 'contain'); await grabPoster();
        if (canRec) { startRec(); const t0 = performance.now(); await new Promise((res) => { (function f() { drawSquare(g, im, im.naturalWidth, im.naturalHeight, SIZE, 'contain'); const el = (performance.now() - t0) / 1000; prog(el / secs); if (el >= secs) res(); else requestAnimationFrame(f); })(); }); }
      }
      const anim = await stopRec();
      if (!poster || !poster.size) throw new Error('Could not read that file');
      if (anim && anim.size > 1.9 * 1024 * 1024) throw new Error('The animated logo is too big. Use a shorter or simpler clip.');
      return { poster, anim: anim && anim.size ? anim : null, secs };
    } finally { URL.revokeObjectURL(url); }
  }
  // upload into the public 'bb-media' bucket under the signed-in user's folder → public URL
  async function upload(c, path, blob) {
    const uid = (await c.auth.getUser()).data.user.id;
    const ext = blob.type === 'video/webm' ? 'webm' : blob.type === 'image/png' ? 'png' : 'webp';
    const full = uid + '/' + path.replace(/^\/+/, '') + '-' + Date.now().toString(36) + '.' + ext;
    const { error } = await c.storage.from('bb-media').upload(full, blob, { contentType: blob.type, upsert: true, cacheControl: '31536000' });
    if (error) throw new Error(error.message || 'Upload failed');
    return c.storage.from('bb-media').getPublicUrl(full).data.publicUrl;
  }
  // best-effort removal of uploaded files (URLs) or of a whole folder ("<uid>/s/<season>")
  async function removeMedia(c, urls) {
    const keys = (urls || []).filter(Boolean).map((u) => (String(u).split('/object/public/bb-media/')[1] || '')).filter(Boolean);
    if (keys.length) { try { await c.storage.from('bb-media').remove(keys); } catch (e) {} }
  }
  async function removeFolder(c, folder) {
    try { const { data } = await c.storage.from('bb-media').list(folder, { limit: 1000 }); const ks = (data || []).map((o) => folder + '/' + o.name); if (ks.length) await c.storage.from('bb-media').remove(ks); } catch (e) {}
  }
  window.PBB = { lookPanel, client, rpc, connect, uuid, errText, errCode, clockLeft, fmtClock, fmtShot, periodLabel, colorDist, MIN_DIST, ELECTRIC,
    playerName, FOUL, FOUL_SHORT, BREAKS, PRESETS, esc, imageToData, cropLogo, toWebp, seasonLogo, upload, removeMedia, removeFolder, enabled: !!(cfg.supabaseUrl && cfg.supabaseAnonKey) };
})();
