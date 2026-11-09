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
    DUPLICATE_JERSEY: 'That jersey number is already used on this team.', LIVE_PASS_REQUIRED: 'An active LIVE pass or free trial is needed to create basketball matches.',
    SIGN_IN_REQUIRED: 'Sign in first.', NO_MATCH: 'Match not found.', PIN_LOCKED: 'Too many wrong PINs. Wait 10 minutes.',
    SCOREKEEPER_TAKEN: 'A scorekeeper is already connected. The host can allow more devices.', TEAM_NAME_REQUIRED: 'Both teams need a name.',
    TEXT_REQUIRED: 'Type the announcement first.', BAD_PERIOD: 'Invalid period.'
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
  function connect(opts) {
    let c = null, ch = null, snap = null, offset = 0, status = 'connecting', closed = false, retryT = null, key = opts.key;
    const setStatus = (s) => { if (s !== status) { status = s; opts.onStatus && opts.onStatus(s); } };
    function apply(s, last) {
      if (!s || !s.code) return false;
      if (snap && s.version < snap.version) return false;          // stale push
      if (typeof s.now === 'number') offset = s.now - Date.now();
      const fresh = !snap || s.version !== snap.version;
      snap = s;
      if (fresh || last) opts.onSnap && opts.onSnap(s, last || null);
      return true;
    }
    async function refresh() {
      if (!c) return;
      try {
        const s = await rpc(c, 'bb_snapshot', { p_code: opts.code, p_key: key || null, p_token: opts.token || null });
        apply(s, null); if (ch && ch._live) setStatus('live');
      } catch (e) { opts.onError && opts.onError(e); if (/NOT_PAIRED|REVOKED|NO_MATCH/.test(String(e.message))) setStatus('denied'); }
    }
    function subscribe() {
      if (!key || closed) return;
      if (ch) { try { c.removeChannel(ch); } catch (e) {} ch = null; }
      ch = c.channel('bb:' + key, { config: { broadcast: { self: false, ack: false } } });
      ch.on('broadcast', { event: 'state' }, (e) => {
        const p = e.payload || {}; const last = p.last || null; delete p.last;
        apply(p, last);
      });
      ch.subscribe((st) => {
        if (st === 'SUBSCRIBED') { ch._live = true; setStatus('live'); refresh(); }   // re-sync after every (re)connect
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
          ch && (ch._live = false); setStatus('offline');
          clearTimeout(retryT); retryT = setTimeout(() => { if (!closed) subscribe(); }, 3000);
        }
      });
    }
    (async () => {
      c = await client(!!opts.signedIn);
      if (!key) { try { const s = await rpc(c, 'bb_snapshot', { p_code: opts.code, p_key: null, p_token: opts.token || null }); apply(s); } catch (e) { setStatus('denied'); opts.onError && opts.onError(e); return; } }
      subscribe();
    })().catch((e) => { setStatus('offline'); opts.onError && opts.onError(e); });
    window.addEventListener('online', () => { if (!closed) subscribe(); });
    window.addEventListener('offline', () => setStatus('offline'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !closed) refresh(); });
    setInterval(() => { if (!closed && status === 'live' && document.visibilityState === 'visible') refresh(); }, 30000);   // safety net

    return {
      get snap() { return snap; }, get status() { return status; }, get offset() { return offset; },
      serverNow: () => Date.now() + offset,
      setKey(k) { if (k && k !== key) { key = k; subscribe(); } },
      refresh, apply,
      async act(type, data, id) {
        if (status !== 'live') throw new Error('OFFLINE');
        const s = await rpc(c, 'bb_act', { p_code: opts.code, p_token: opts.token || null, p_id: id || uuid(), p_type: type, p_data: data || {} });
        const last = s.last; delete s.last; apply(s, last); return s;
      },
      async events() { return rpc(c, 'bb_events', { p_code: opts.code, p_key: key || null, p_token: opts.token || null }); },
      close() { closed = true; try { ch && c.removeChannel(ch); } catch (e) {} }
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

  window.PBB = { client, rpc, connect, uuid, errText, errCode, clockLeft, fmtClock, fmtShot, periodLabel, colorDist, MIN_DIST, ELECTRIC,
    playerName, FOUL, FOUL_SHORT, BREAKS, PRESETS, esc, imageToData, enabled: !!(cfg.supabaseUrl && cfg.supabaseAnonKey) };
})();
