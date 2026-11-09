/* Google sign-in + day-pass credits via Supabase. Disabled (free mode) when js/config.js is empty. */
(function () {
  const cfg = window.PB_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const SB_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
  ];
  let sb = null, user = null, profile = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(api); } catch (e) {} });

  // Sign-in lock that only waits within this tab. supabase-js's default lock is shared by every open tab of the
  // site, so a frozen background tab (common on Android) could block sign-in forever ("Loading…").
  const tabLocks = {};
  async function tabLock(name, _timeout, fn) {
    const prev = tabLocks[name] || Promise.resolve();
    let release; const mine = new Promise((r) => { release = r; });
    tabLocks[name] = prev.then(() => mine);
    await prev.catch(() => {});
    try { return await fn(); } finally { release(); }
  }
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'TIMEOUT')), ms))]);
  let initPromise = null;
  function init() { if (!initPromise) initPromise = doInit().catch((e) => { initPromise = null; throw e; }); return initPromise; }
  async function doInit() {
    if (!enabled) { emit(); return api; }
    await withTimeout(PBCommon.loadScript(SB_URLS), 20000, 'Could not load the sign-in library — check the internet connection');
    if (!sb) sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', lock: tabLock }
    });
    const { data } = await withTimeout(sb.auth.getSession(), 15000, 'Sign-in is taking too long — check the internet connection');
    user = data.session ? data.session.user : null;
    if (user) await refresh(); else emit();
    sb.auth.onAuthStateChange((_ev, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      // never call Supabase directly inside this callback (it can deadlock); do it on the next tick
      if ((user && user.id) !== was) { profile = null; setTimeout(refresh, 0); }
    });
    return api;
  }

  /* Live "who's online" presence for the lobby. Each open scoreboard / phone joins one shared channel.
   * onUpdate gets { online, boards, courts, phones, players, active }. Returns { update(state) }. */
  let liveClient = null;
  async function getLiveClient() {
    await PBCommon.loadScript(SB_URLS);
    if (!liveClient) liveClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'aopb-live' }
    });
    return liveClient;
  }
  /* Internet relay for the phone <-> scoreboard link (works on any network, no WebRTC needed). */
  async function relay(name, onMsg) {
    if (!enabled) return null;
    const c = await getLiveClient();
    const ch = c.channel(name, { config: { broadcast: { self: false, ack: false } } });
    ch.on('broadcast', { event: 'm' }, (e) => { try { onMsg(e.payload); } catch (err) {} }).subscribe();
    return {
      send(p) { try { ch.send({ type: 'broadcast', event: 'm', payload: p }); } catch (e) {} },
      close() { try { c.removeChannel(ch); } catch (e) {} }
    };
  }
  async function live(id, state, onUpdate) {
    if (!enabled) return null;
    const c = await getLiveClient();
    let stats = {}, cur = state;
    const ch = c.channel('dk-online', { config: { presence: { key: id } } });
    const tally = () => {
      let boards = 0, courts = 0, phones = 0;
      Object.values(ch.presenceState()).forEach((arr) => {
        const m = (arr && arr[0]) || {};
        if (m.r === 'board') { boards++; if (m.live) courts++; } else phones++;
      });
      onUpdate({ online: boards + phones, boards, courts, phones, players: stats.players, active: stats.active_passes });
    };
    ch.on('presence', { event: 'sync' }, tally)
      .subscribe((s) => { if (s === 'SUBSCRIBED') ch.track(cur).catch(() => {}); });
    const loadStats = async () => { try { const { data } = await c.rpc('app_stats'); if (data) { stats = data; tally(); } } catch (e) {} };
    loadStats(); setInterval(loadStats, 120000);
    return { update(s) { cur = s; ch.track(s).catch(() => {}); } };
  }

  async function refresh() {
    if (!sb || !user) { profile = null; emit(); return null; }
    // The profile row is created by a database trigger right after first sign-in; retry briefly.
    for (let i = 0; i < 4; i++) {
      let data = null, error = null;
      try { ({ data, error } = await withTimeout(sb.from('profiles').select('*').eq('id', user.id).maybeSingle(), 12000)); } catch (e) { error = e; }
      if (!error && data) { profile = data; break; }
      await new Promise((r) => setTimeout(r, 600));
    }
    emit();
    return profile;
  }

  /* ---------- Google Identity Services: the sign-in happens on dinkykong.pro, so Google's screen shows
   * our site instead of the Supabase address. Needs PB_CONFIG.googleClientId; without it the old redirect is used. */
  const GIS_URL = ['https://accounts.google.com/gsi/client'];
  let gisReady = null, gisNonce = null, gisWaiters = [];
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''); }
  function gisOn() { return !!(enabled && cfg.googleClientId); }
  function initGis() {
    if (!gisReady) gisReady = (async () => {
      await init();
      await withTimeout(PBCommon.loadScript(GIS_URL), 15000, 'Could not load Google sign-in');
      gisNonce = b64url(crypto.getRandomValues(new Uint8Array(24)).buffer);
      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        nonce: await sha256hex(gisNonce),
        auto_select: false, cancel_on_tap_outside: true, itp_support: true, use_fedcm_for_prompt: true, context: 'signin',
        callback: async (resp) => {
          let err = null;
          try {
            const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce: gisNonce });
            if (error) err = error;
          } catch (e) { err = e; }
          if (err) gisWaiters.forEach((f) => { try { f(String(err.message || err)); } catch (e) {} });
          // success: onAuthStateChange → refresh → listeners (no page reload needed)
        }
      });
    })().catch((e) => { gisReady = null; throw e; });
    return gisReady;
  }
  // Renders Google's official button inside `el`. Returns true when the Google button is shown.
  async function mountGoogleButton(el, opts) {
    if (!gisOn() || !el) return false;
    try {
      await initGis();
      el.innerHTML = '';
      window.google.accounts.id.renderButton(el, Object.assign({ type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: Math.min(400, Math.max(220, el.clientWidth || 320)) }, opts || {}));
      return true;
    } catch (e) { return false; }
  }
  function onGoogleError(f) { gisWaiters.push(f); }

  function signIn(returnTo) {
    if (!sb) return;
    return sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: returnTo ? new URL(returnTo, location.href).href : location.href, queryParams: { prompt: 'select_account' } }
    });
  }
  async function signOut() {
    // 'local': sign out THIS device only (the default 'global' would also kill the screen / other phones)
    if (sb) { try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {} }
    try { window.google && window.google.accounts && window.google.accounts.id.disableAutoSelect(); } catch (e) {}
    user = null; profile = null; emit();
  }

  function passUntil() { return profile && profile.pass_until ? new Date(profile.pass_until) : null; }
  function passActive() { const p = passUntil(); return !!p && p.getTime() > Date.now(); }

  async function startPass() {
    if (!sb) return { ok: false, error: 'DISABLED' };
    const { data, error } = await sb.rpc('start_day_pass');
    await refresh();
    if (error) {
      const m = String(error.message || '');
      return { ok: false, error: m.includes('NO_CREDITS') ? 'NO_CREDITS' : m };
    }
    return { ok: true, until: data };
  }

  // Admin helpers
  async function listUsers() {
    const { data, error } = await sb.from('profiles').select('id,email,full_name,avatar_url,credits,hours_balance,bound_device,pass_until,live_hours,live_until,is_admin,created_at').order('created_at', { ascending: false });
    if (error) throw error; return data;
  }
  async function ledgerPage(page, size) {
    const from = page * size;
    const { data, error, count } = await sb.from('credit_ledger').select('id,user_id,delta,reason,created_at', { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, from + size - 1);
    if (error) throw error; return { rows: data, total: count || 0 };
  }
  async function ledger(limit) {
    const { data, error } = await sb.from('credit_ledger').select('id,user_id,delta,reason,created_at').order('created_at', { ascending: false }).limit(limit || 50);
    if (error) throw error; return data;
  }
  async function addCredits(email, amount, note) {
    const { data, error } = await sb.rpc('admin_add_credits', { target_email: email, amount, note: note || null });
    if (error) throw new Error(String(error.message || error).replace(/^.*?(NOT_ADMIN|USER_NOT_FOUND|ZERO_AMOUNT).*$/, '$1'));
    return data;
  }

  async function accessToken() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session ? data.session.access_token : null;
  }

  /* Used by the TV scoreboard (not signed in itself): checks a phone's Google session with Supabase.
   * Starts a 24-hour pass (1 credit) if none is active. Returns {ok, until, name, email, credits} or {ok:false, reason}. */
  async function verifyToken(token, opts) {
    if (!enabled) return { ok: true, free: true };
    const charge = !(opts && opts.charge === false);
    if (!token) return { ok: false, reason: 'NOT_SIGNED_IN' };
    await PBCommon.loadScript(SB_URLS);
    const c = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    });
    const { data: who } = await c.auth.getUser(token);
    if (!who || !who.user) return { ok: false, reason: 'NOT_SIGNED_IN' };
    const live = !!(opts && opts.live);   // LIVE screen: start the organizer's LIVE pass instead of the solo pass
    const { data: until, error } = await c.rpc(live ? 'start_live_pass' : 'start_pass', { p_device: (opts && opts.device) || '' });
    const uid = who && who.user ? who.user.id : null;
    const { data: prof } = uid ? await c.from('profiles').select('email,full_name,credits,pass_until,live_until,trial_until').eq('id', uid).maybeSingle() : { data: null };
    if (error) {
      const m = String(error.message || '');
      const reason = m.includes('NO_LIVE_PASS') ? 'NO_LIVE_PASS' : m.includes('NO_CREDITS') ? 'NO_CREDITS' : m.includes('OTHER_DEVICE') ? 'OTHER_DEVICE' : (m.includes('JWT') || m.includes('NOT_SIGNED_IN')) ? 'NOT_SIGNED_IN' : 'ERROR';
      return { ok: false, reason, email: prof && prof.email, name: prof && prof.full_name };
    }
    // Club branding on the scoreboard is part of the LIVE pass (and the new-account free trial)
    const brandUntil = Math.max(prof && prof.live_until ? new Date(prof.live_until).getTime() : 0, prof && prof.trial_until ? new Date(prof.trial_until).getTime() : 0);
    return { ok: true, until, email: prof && prof.email, name: prof && prof.full_name, credits: prof && prof.credits, brand: brandUntil > Date.now(), brandUntil: brandUntil || null };
  }

  // ---- Packages & payments ----
  const FALLBACK_PACKAGES = [
    { code: 'day', label: '24 hours', hours: 24, price_php: 50 }, { code: '3day', label: '3 days', hours: 72, price_php: 150 },
    { code: 'week', label: '1 week', hours: 168, price_php: 300 }, { code: 'month', label: '1 month', hours: 720, price_php: 800 }];
  async function packages(kind) {   // 'solo' (default) or 'live'
    kind = kind || 'solo';
    if (!sb) return kind === 'live' ? LIVE_FALLBACK : FALLBACK_PACKAGES;
    const { data, error } = await sb.from('packages').select('code,label,hours,price_php,kind').eq('kind', kind).order('sort');
    return (!error && data && data.length) ? data : (kind === 'live' ? LIVE_FALLBACK : FALLBACK_PACKAGES);
  }
  const LIVE_FALLBACK = [
    { code: 'live1h', label: 'LIVE · 1 hour', hours: 1, price_php: 20, kind: 'live' },
    { code: 'live4h', label: 'LIVE · 4 hours', hours: 4, price_php: 50, kind: 'live' },
    { code: 'live', label: 'LIVE · 1 day', hours: 24, price_php: 150, kind: 'live' },
    { code: 'live3d', label: 'LIVE · 3 days', hours: 72, price_php: 300, kind: 'live' }];
  function liveUntil() { return profile && profile.live_until ? new Date(profile.live_until) : null; }
  function errCode(e) { const m = String((e && e.message) || e || ''); const k = m.match(/[A-Z_]{6,}/); return k ? k[0] : m; }
  async function requestPurchase(pkg, ref) {
    const { data, error } = await sb.rpc('request_purchase', { p_package: pkg, p_reference: ref });
    if (error) throw new Error(errCode(error)); return data;
  }
  // Match history (finished matches saved by the signed-in scorer)
  async function saveMatch(m) {
    if (!sb || !user) return { ok: false };
    const { error } = await sb.from('matches').insert(Object.assign({ user_id: user.id }, m));
    if (error && !String(error.code).includes('23505')) return { ok: false, error: error.message };
    return { ok: true };
  }
  async function myMatches() {
    if (!sb || !user) return [];
    const { data } = await sb.from('matches').select('id,match_key,played_at,mode,names,colors,players,settings,games,winner,stats').eq('user_id', user.id).order('played_at', { ascending: false }).limit(100);
    return data || [];
  }
  async function deleteMatch(id) { if (!sb || !user) return; await sb.from('matches').delete().eq('id', id); }
  async function myPurchases() {
    if (!sb || !user) return [];
    const { data } = await sb.from('purchases').select('id,package,amount_php,reference,status,created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
    return data || [];
  }
  async function adminPurchases(status) {
    let q = sb.from('purchases').select('id,user_id,package,hours,amount_php,reference,status,created_at,reviewed_at,note').order('created_at', { ascending: status === 'pending' }).limit(100);
    if (status) q = q.eq('status', status);
    const { data, error } = await q; if (error) throw error; return data;
  }
  async function reviewPurchase(id, approve, note) {
    const { data, error } = await sb.rpc('admin_review_purchase', { p_id: id, p_approve: approve, p_note: note || null });
    if (error) throw new Error(errCode(error)); return data;
  }
  async function addHours(email, hours, note) {
    const { data, error } = await sb.rpc('admin_add_hours', { target_email: email, p_hours: hours, note: note || null });
    if (error) throw new Error(errCode(error)); return data;
  }
  async function resetDevice(uid) {
    const { error } = await sb.rpc('admin_reset_device', { target: uid });
    if (error) throw new Error(errCode(error));
  }

  // Free mode counts as "allowed"
  function allowed() { return !enabled || passActive(); }

  const api = { saveMatch, myMatches, deleteMatch,
    enabled, init, refresh, signIn, signOut, startPass, passActive, passUntil, allowed, accessToken, verifyToken,
    async savePush(sub) {
      const j = sub.toJSON();
      const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      if (error) throw error;
    },
    async deletePush(endpoint) { await sb.rpc('delete_push_subscription', { p_endpoint: endpoint }); },
    get client() { return sb; },
    async undoApproval(id) { const { data, error } = await sb.rpc('admin_undo_approval', { p_id: id }); if (error) throw new Error(error.message); return data; },
    live, relay, liveUntil, mountGoogleButton, onGoogleError, get googleButtons() { return gisOn(); },
    // LIVE trial codes
    async redeemLiveCode(code, screen) {
      if (!enabled) return { ok: true, until: new Date(Date.now() + 3600e3).toISOString() };
      const c = await getLiveClient();
      const { data, error } = await c.rpc('redeem_live_code', { p_code: code, p_screen: screen });
      if (error) { const m = String(error.message || ''); return { ok: false, reason: (m.match(/BAD_CODE|USED_CODE|EXPIRED_CODE/) || ['ERROR'])[0] }; }
      return { ok: true, until: data };
    },
    async createLiveCode(note) { const { data, error } = await sb.rpc('admin_create_live_code', { p_note: note || null }); if (error) throw new Error(error.message); return data; },
    async listLiveCodes() { const { data, error } = await sb.from('live_codes').select('code,note,minutes,created_at,expires_at,redeemed_at,revoked').order('created_at', { ascending: false }).limit(30); if (error) throw error; return data; },
    async revokeLiveCode(code) { const { error } = await sb.rpc('admin_revoke_live_code', { p_code: code }); if (error) throw new Error(error.message); },
    listUsers, ledger, ledgerPage, addCredits, packages, requestPurchase, myPurchases, adminPurchases, reviewPurchase, addHours, resetDevice,
    get user() { return user; }, get profile() { return profile; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); }
  };
  window.PBAuth = api;
})();
