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

  async function init() {
    if (!enabled) { emit(); return api; }
    await PBCommon.loadScript(SB_URLS);
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    });
    const { data } = await sb.auth.getSession();
    user = data.session ? data.session.user : null;
    if (user) await refresh(); else emit();
    sb.auth.onAuthStateChange((_ev, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      if ((user && user.id) !== was) { profile = null; refresh(); }
    });
    return api;
  }

  async function refresh() {
    if (!sb || !user) { profile = null; emit(); return null; }
    // The profile row is created by a database trigger right after first sign-in; retry briefly.
    for (let i = 0; i < 4; i++) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (!error && data) { profile = data; break; }
      await new Promise((r) => setTimeout(r, 600));
    }
    emit();
    return profile;
  }

  function signIn() {
    if (!sb) return;
    return sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.href, queryParams: { prompt: 'select_account' } }
    });
  }
  async function signOut() { if (sb) await sb.auth.signOut(); user = null; profile = null; emit(); }

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
    const { data, error } = await sb.from('profiles').select('id,email,full_name,avatar_url,credits,pass_until,is_admin,created_at').order('created_at', { ascending: false });
    if (error) throw error; return data;
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
    const { data: until, error } = charge ? await c.rpc('start_day_pass') : { data: null, error: null };
    const uid = who && who.user ? who.user.id : null;
    const { data: prof } = uid ? await c.from('profiles').select('email,full_name,credits,pass_until').eq('id', uid).maybeSingle() : { data: null };
    if (error) {
      const m = String(error.message || '');
      const reason = m.includes('NO_CREDITS') ? 'NO_CREDITS' : (m.includes('JWT') || m.includes('NOT_SIGNED_IN')) ? 'NOT_SIGNED_IN' : 'ERROR';
      return { ok: false, reason, email: prof && prof.email, name: prof && prof.full_name };
    }
    return { ok: true, until, email: prof && prof.email, name: prof && prof.full_name, credits: prof && prof.credits };
  }

  // Free mode counts as "allowed"
  function allowed() { return !enabled || passActive(); }

  const api = {
    enabled, init, refresh, signIn, signOut, startPass, passActive, passUntil, allowed, accessToken, verifyToken,
    listUsers, ledger, addCredits,
    get user() { return user; }, get profile() { return profile; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); }
  };
  window.PBAuth = api;
})();
