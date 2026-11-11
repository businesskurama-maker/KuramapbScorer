/* Basketball LIVE OBS — host portal: matches, setup & rosters, OBS monitor + pairing, stats/history/export. */
(function () {
  const $ = (id) => document.getElementById(id);
  const E = PBB.esc;
  let sb = null, cur = null, H = null, conn = null, view = 'matches', draft = null, devT = null;
  let toastT;
  function toast(t, err) { const el = $('toast'); el.textContent = t; el.classList.toggle('err', !!err); el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), err ? 3600 : 2000); }
  const MUT = ['bb_create', 'bb_update', 'bb_roster', 'bb_delete', 'bb_revoke', 'bb_season_save', 'bb_season_team', 'bb_season_team_delete', 'bb_season_player', 'bb_season_player_delete', 'bb_season_delete'];
  const rpc = async (fn, args) => { const r = await PBB.rpc(sb, fn, args); if (MUT.includes(fn)) link.send('changed', { code: (args && args.p_code) || (r && r.code) || cur }); return r; };

  /* ---------- phone ⇄ screen link (same account): navigation, live setup typing, "data changed" ---------- */
  const DEV_ID = Math.random().toString(36).slice(2, 10);
  const IS_PHONE = matchMedia('(max-width: 760px)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
  const link = (() => {
    let ch = null, others = [], applying = false;
    const follow = () => { try { return localStorage.getItem('dk.bb.follow') === '1'; } catch (e) { return false; } };
    let lUid = null, lOk = false, lAt = 0, lRetry = null, lHid = 0;
    function start(uid) {
      if (!sb || !uid) return;
      if (ch && lUid === uid) return;
      lUid = uid; join();
      if (!start.wired) {   // rejoin after sleep / network change
        start.wired = true;
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { lHid = Date.now(); return; } const away = lHid ? Date.now() - lHid : 0; lHid = 0; if (!lOk || away > 15000) join(); });
        addEventListener('online', join);
        setInterval(() => { if (document.visibilityState === 'visible' && !lOk && Date.now() - lAt > 10000) join(); }, 4000);
      }
    }
    function join() {
      if (!sb || !lUid) return;
      clearTimeout(lRetry);
      if (ch) { const old = ch; ch = null; try { sb.removeChannel(old); } catch (e) {} }
      lOk = false; lAt = Date.now();
      const me = sb.channel('bbu:' + lUid, { config: { broadcast: { self: false }, presence: { key: DEV_ID } } });
      ch = me;
      me.on('broadcast', { event: 'm' }, (e) => onMsg(e.payload || {}));
      me.on('presence', { event: 'sync' }, () => { if (ch !== me) return; const st = me.presenceState(); others = Object.keys(st).filter((k) => k !== DEV_ID).map((k) => st[k][0] || {}); paintLink(); });
      me.subscribe((st) => {
        if (ch !== me) return;
        if (st === 'SUBSCRIBED') { lOk = true; me.track({ kind: IS_PHONE ? 'phone' : 'screen', at: Date.now() }); }
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') { lOk = false; lRetry = setTimeout(join, 3000); }
      });
    }
    function send(t, data) { if (ch && !applying) { try { ch.send({ type: 'broadcast', event: 'm', payload: Object.assign({ t, from: DEV_ID }, data) }); } catch (e) {} } }
    function onMsg(m) {
      if (m.from === DEV_ID) return;
      if (m.t === 'nav' && follow()) { applying = true; try { cur = m.code || null; if (m.view === 'setup' && !cur) draft = m.draft || null; go(m.view); } finally { applying = false; } }
      if (m.t === 'draft' && follow() && view === 'setup' && (m.code || null) === cur && !document.activeElement.closest('#vSetup')) { draft = m.draft; mirrorDraft(); }
      if (m.t === 'changed') {
        if (view === 'matches') loadMatches();
        else if (view === 'seasons') { if (!document.activeElement.closest('#vSeasons')) openSeasons(); }
        else if ((m.code || '') === (cur || '') || !cur) {
          if (view === 'monitor') openMonitor(); else if (view === 'summary') openSummary();
          else if (view === 'setup' && cur && !document.activeElement.closest('#vSetup')) openSetup();
        }
        toast(IS_PHONE ? 'Updated from the screen' : 'Updated from your phone');
      }
    }
    function paintLink() {
      const ph = others.filter((o) => o.kind === 'phone').length, sc = others.filter((o) => o.kind === 'screen').length;
      const n = IS_PHONE ? sc : ph; const el = $('linkChip'); if (!el) return;
      el.classList.toggle('hidden', !n);
      el.innerHTML = '<span class="dot on"></span>' + (IS_PHONE ? (n === 1 ? 'Screen connected' : n + ' screens connected') : (n === 1 ? 'Phone connected' : n + ' phones connected'))
        + (IS_PHONE ? '' : ' · <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="followT"' + (follow() ? ' checked' : '') + '> follow phone</label>');
      const f = $('followT'); if (f) f.onchange = () => { try { localStorage.setItem('dk.bb.follow', f.checked ? '1' : '0'); } catch (e) {} };
    }
    return { start, send, get applying() { return applying; } };
  })();
  let draftT = null;
  function sendDraft() { clearTimeout(draftT); draftT = setTimeout(() => { if (!draft) return;
    const d = JSON.parse(JSON.stringify(draft)); let size = JSON.stringify(d).length;
    if (size > 180000) { ['home', 'away'].forEach((t) => { if (d[t].logo) d[t].logo = ''; }); d.players.forEach((p) => { delete p.photo; }); }
    link.send('draft', { code: cur, draft: d }); }, 350); }
  function mirrorDraft() { $('fTitle').value = draft.title || ''; $('fRound').value = (draft.broadcast || {}).round || ''; setTimeout(bnPrev); $('fVenue').value = draft.venue || ''; paintTeams(); paintRules(); }

  /* ---------------- auth gate ---------------- */
  async function boot() {
    if (!PBB.enabled) { $('gate').classList.remove('hidden'); $('gateMsg').textContent = 'Sign-in is not configured on this copy of the app.'; return; }
    try { await PBAuth.init(); } catch (e) { $('gate').classList.remove('hidden'); $('gateMsg').textContent = PBB.errText(e); return; }
    sb = PBAuth.client;
    PBAuth.onChange(() => paintAuth());
    paintAuth();
  }
  let shownFor = null;
  function paintAuth() {
    const u = PBAuth.user;
    $('gate').classList.toggle('hidden', !!u); $('tabs').classList.toggle('hidden', !u); $('main').classList.toggle('hidden', !u);
    $('outBtn').classList.toggle('hidden', !u); $('who').textContent = u ? (u.email || '') : '';
    if (!u) { PBAuth.mountGoogleButton($('gis')).then((ok) => $('inBtn').classList.toggle('hidden', ok)); phoneLogin.start(); return; }
    phoneLogin.stop();
    const p = PBAuth.profile || {}, now = Date.now();
    const until = Math.max(p.live_until ? Date.parse(p.live_until) : 0, p.trial_until ? Date.parse(p.trial_until) : 0);
    const bbu = p.bb_until ? Date.parse(p.bb_until) : 0;
    const left = bbu - now, hrs = Math.floor(left / 3600000), days = Math.floor(hrs / 24);
    $('passCard').className = 'p-card pass-card ' + (p.is_admin || left > 0 ? 'ok' : 'off');
    $('passTxt').textContent = p.is_admin ? 'Owner · unlimited' : left > 0 ? (days >= 1 ? days + ' day' + (days > 1 ? 's' : '') + ' ' + (hrs % 24) + ' h left' : hrs >= 1 ? hrs + ' h ' + Math.floor(left / 60000) % 60 + ' min left' : Math.max(1, Math.floor(left / 60000)) + ' min left') : 'Pass ended';
    $('passSub').textContent = p.is_admin ? 'You can always create matches.' : left > 0 ? 'Active until ' + new Date(bbu).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Redeem a code or donate to create new matches. Saved matches stay available.';
    passOk = !!(p.is_admin || bbu > now || !('bb_until' in p));
    if (shownFor !== u.id) { shownFor = u.id; link.start(u.id); route(); }
  }
  $('inBtn').onclick = () => PBAuth.signIn(location.href);

  /* Sign in this screen with a phone: QR → phone signs in + approves → this screen receives its own session. */
  const phoneLogin = (() => {
    let req = null, pollT = null, on = false, busy = false;
    async function fresh() {
      try {
        const c = await PBB.client(false);
        req = await PBB.rpc(c, 'bb_login_start', { p_agent: navigator.userAgent.slice(0, 80) });
        const url = location.href.replace(/[^/]*$/, '') + 'bb-login.html?r=' + req.id;
        await PBCommon.loadScript(PBCommon.LIBS.qr);
        const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
        $('qlQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true }); $('qlQr').classList.remove('old');
        $('qlCode').textContent = req.code; $('qlMsg').textContent = 'This screen signs in by itself as soon as you approve on the phone.';
      } catch (e) { $('qlMsg').textContent = PBB.errText(e); setTimeout(() => on && fresh(), 8000); }
    }
    async function poll() {
      if (!on || !req || busy) return;
      busy = true;
      try {
        const c = await PBB.client(false);
        const r = await PBB.rpc(c, 'bb_login_poll', { p_id: req.id, p_secret: req.secret });
        if (r.status === 'approved' && r.session) {
          $('qlMsg').textContent = 'Approved by ' + (r.email || 'your phone') + ' · signing in…';
          stop();
          try { localStorage.setItem('dk.bb.follow', '1'); } catch (e) {}
          const { error } = await PBAuth.client.auth.setSession(r.session);
          if (error) { $('qlMsg').textContent = PBB.errText(error); start(); }
        } else if (r.status === 'expired' || r.status === 'missing' || r.status === 'consumed') { $('qlQr').classList.add('old'); await fresh(); }
        else if (r.status === 'denied') { $('qlMsg').textContent = 'Request declined on the phone. New QR ready.'; await fresh(); }
      } catch (e) { /* keep polling */ }
      busy = false;
    }
    function start() { if (on) return; on = true; fresh(); clearInterval(pollT); pollT = setInterval(poll, 2000); }
    function stop() { on = false; clearInterval(pollT); }
    return { start, stop };
  })();
  $('outBtn').onclick = () => PBAuth.signOut();

  /* ---------------- routing ---------------- */
  function route() {
    const h = new URLSearchParams(location.hash.slice(1));
    cur = h.get('m') || null; SS.id = h.get('s') || null;
    go(h.get('v') || (cur ? 'monitor' : 'matches'), true);
  }
  function setHash() { const h = new URLSearchParams(); h.set('v', view); if (cur) h.set('m', cur); if (view === 'seasons' && SS.id) h.set('s', SS.id); history.replaceState(null, '', '#' + h); }
  function go(v, noHash) {
    if ((v === 'monitor' || v === 'summary') && !cur) { if (v !== view) toast('Pick a match first — tap OBS Monitor on a match card, or create one.'); v = 'matches'; }
    view = v;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    ['matches', 'seasons', 'setup', 'monitor', 'summary'].forEach((k) => $('v' + k[0].toUpperCase() + k.slice(1)).classList.toggle('hidden', k !== v));
    setHash();
    link.send('nav', { view: v, code: cur, draft: v === 'setup' && !cur ? draft : null });
    if (v !== 'monitor') { clearInterval(devT); }
    if (v === 'matches') loadMatches();
    if (v === 'seasons') openSeasons();
    if (v === 'setup') openSetup();
    if (v === 'monitor') openMonitor();
    if (v === 'summary') openSummary();
  }
  $('tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if ((b.dataset.v === 'monitor' || b.dataset.v === 'summary') && !cur) { toast('Open a match first'); return; } if (b.dataset.v === 'setup' && !cur) draft = null; go(b.dataset.v); };

  /* ---------------- matches ---------------- */
  async function loadMatches() {
    const { data, error } = await sb.from('bb_matches').select('code,owner,title,venue,status,home,away,derived,created_at,starts_at,finalized_at,season_id').order('created_at', { ascending: false }).limit(100);
    if (error) { $('mlist').innerHTML = '<div class="tiny">' + E(PBB.errText(error)) + '</div>'; return; }
    await seasonNames();
    $('mlist').innerHTML = (data || []).map((m) => {
      const sc = (m.derived && m.derived.score) || { home: 0, away: 0 };
      const when = new Date(m.starts_at || m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return '<div class="mcard"><div class="tt"><span>' + E(m.title || 'Untitled match') + (m.venue ? ' · ' + E(m.venue) : '') + '</span><span class="st ' + m.status + '">' + m.status.toUpperCase() + '</span></div>'
        + '<div class="vs"><span style="color:' + E(m.home.color) + '">' + E(m.home.name) + '</span><b>' + sc.home + ' – ' + sc.away + '</b><span style="color:' + E(m.away.color) + '">' + E(m.away.name) + '</span></div>'
        + '<div class="tiny">' + (m.season_id && SS.names[m.season_id] ? '<span class="ss-chip">🏆 ' + E(SS.names[m.season_id]) + '</span> ' : '') + when + ' · ID ' + m.code + (PBAuth.user && m.owner !== PBAuth.user.id ? ' · <span style="color:var(--warn)">another account</span>' : '') + '</div>'
        + '<div class="row" style="flex-wrap:wrap"><button class="btn sm cyan" data-o="monitor" data-c="' + m.code + '">OBS Monitor</button><button class="btn sm" data-o="setup" data-c="' + m.code + '">Setup</button><button class="btn sm" data-o="summary" data-c="' + m.code + '">Stats</button><button class="btn sm ghost" data-del="' + m.code + '">Delete</button></div></div>';
    }).join('') || '<div class="m-empty"><div style="font-size:34px">🏀</div><b>No matches yet</b><span class="tiny">Create a match to set up teams, rosters and the OBS scoreboard.</span></div>';
  }
  $('mlist').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.del) { if (!confirm('Delete match ' + b.dataset.del + ' and all its events? This cannot be undone.')) return; try { await rpc('bb_delete', { p_code: b.dataset.del }); toast('Deleted'); loadMatches(); } catch (x) { toast(PBB.errText(x), true); } return; }
    cur = b.dataset.c; H = null; go(b.dataset.o);
  };
  let passOk = true;
  $('newBtn').onclick = () => { if (!passOk) { toast('Your Basketball pass has ended', true); openDonate(); return; } cur = null; H = null; draft = null; go('setup'); };
  $('codeIn').addEventListener('input', () => { const v = $('codeIn').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); $('codeIn').value = v.length > 2 ? v.slice(0, 2) + '-' + v.slice(2, 6) + (v.length > 6 ? '-' + v.slice(6) : '') : v; });
  $('codeForm').onsubmit = async (e) => {
    e.preventDefault();
    const c = $('codeIn').value.replace(/[^A-Za-z0-9]/g, '');
    if (c.length < 10) { $('codeMsg').innerHTML = '<span style="color:var(--warn)">Enter the full 10-character code.</span>'; return; }
    $('codeBtn').classList.add('busy'); $('codeMsg').textContent = 'Checking…';
    try { const u = await rpc('redeem_bb_code', { p_code: c }); $('codeIn').value = ''; $('codeMsg').innerHTML = '<span style="color:var(--brand)">Pass extended until ' + new Date(u).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + '</span>';
      if (PBAuth.profile) PBAuth.profile.bb_until = u; shownFor = null; paintAuth(); }
    catch (x) { $('codeMsg').innerHTML = '<span style="color:var(--danger)">' + E(PBB.errText(x)) + '</span>'; }
    finally { $('codeBtn').classList.remove('busy'); }
  };
  $('donBtn').onclick = () => openDonate();
  async function openDonate() {
    let pk = [];
    try { const { data } = await sb.from('packages').select('code,label,hours,price_php').eq('kind', 'bb').order('sort'); pk = data || []; } catch (e) {}
    if (!pk.length) pk = [{ code: 'bb1d', label: 'Basketball · 1 day', hours: 24, price_php: 150 }, { code: 'bb3d', label: 'Basketball · 3 days', hours: 72, price_php: 300 }, { code: 'bb1w', label: 'Basketball · 1 week', hours: 168, price_php: 500 }];
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="sheet don"><h3>Support DinkyKong · Basketball pass</h3>'
      + '<p class="tiny" style="margin:0">DinkyKong is built and run by one independent developer. Your donation goes to the support fund for the app’s <b>storage, database and domain</b> bills. As a thank-you it extends your Basketball LIVE OBS pass.</p>'
      + '<div class="don-pk">' + pk.map((x, i) => '<button class="don-b' + (i === 0 ? ' on' : '') + '" data-c="' + x.code + '" data-p="' + x.price_php + '" data-l="' + E(x.label) + '"><b>' + E(String(x.label || x.code).replace(/^Basketball · /, '')) + '</b><span>PHP ' + x.price_php + '</span></button>').join('') + '</div>'
      + '<div class="don-pay"><img src="icons/instapay-qr.png" alt="InstaPay QR"><ol class="ol"><li>Scan the <b>InstaPay QR</b> with GCash, Maya or any bank app.</li><li>Donate exactly <b id="donAmt">PHP ' + pk[0].price_php + '</b>.</li><li>Type the <b>last 6 digits</b> of the reference number.</li></ol></div>'
      + '<input class="in pin-in" id="donRef" inputmode="numeric" maxlength="6" placeholder="••••••" style="font-family:var(--digit);text-align:center;letter-spacing:.3em">'
      + '<p class="tiny" style="margin:0">Donations are confirmed by hand daily 8:00 AM – 10:00 PM (PH time), usually within 5 minutes to 2 hours. Questions: dinkykongsupport@gmail.com</p>'
      + '<div class="g2"><button class="btn" data-x>Close</button><button class="btn primary" id="donGo">Send reference</button></div></div>';
    document.body.appendChild(m);
    let sel = pk[0].code;
    m.onclick = async (e) => {
      if (e.target === m || e.target.closest('[data-x]')) { m.remove(); return; }
      const b = e.target.closest('.don-b'); if (b) { sel = b.dataset.c; m.querySelectorAll('.don-b').forEach((x) => x.classList.toggle('on', x === b)); m.querySelector('#donAmt').textContent = 'PHP ' + b.dataset.p; return; }
      if (e.target.id === 'donGo') {
        const ref = m.querySelector('#donRef').value.replace(/\D/g, '');
        if (ref.length !== 6) { toast('Enter the last 6 digits of the reference number', true); return; }
        try { await rpc('request_purchase', { p_package: sel, p_reference: ref }); m.querySelector('.sheet').innerHTML = '<h3>Thank you for your support! 💛</h3><p class="muted" style="margin:0">Your pass is extended as soon as the developer confirms the donation (usually 5 minutes to 2 hours, 8 AM – 10 PM PH time). Reload this page later to see it.</p><button class="btn primary" data-x>Done</button>'; }
        catch (x) { toast(PBB.errText(x), true); }
      }
    };
  }

  /* ---------------- setup ---------------- */
  const RULES = [
    ['periods', 'Periods', 'sel', [[4, '4 quarters'], [2, '2 halves'], [3, '3 periods']]], ['period_min', 'Period length (min)', 'num', 1, 60], ['ot_min', 'Overtime length (min)', 'num', 1, 20],
    ['shot_full', 'Shot clock (s)', 'num', 10, 60], ['shot_short', 'Shot clock reset (s)', 'num', 5, 40],
    ['pf_limit', 'Fouls to foul out', 'num', 3, 10], ['tf_limit', 'Team fouls → penalty', 'num', 2, 15], ['tf_reset', 'Team fouls reset', 'sel', [['period', 'Every period'], ['half', 'Every half'], ['game', 'Never (per game)']]],
    ['to_mode', 'Timeouts', 'sel', [['halves', 'Per half (FIBA)'], ['game', 'Per game'], ['period', 'Per period']]], ['to_h1', 'Timeouts 1st half', 'num', 0, 9], ['to_h2', 'Timeouts 2nd half', 'num', 0, 9],
    ['to_game', 'Timeouts per game', 'num', 0, 12], ['to_period', 'Timeouts per period', 'num', 0, 9], ['to_ot', 'Timeouts per overtime', 'num', 0, 5], ['to_secs', 'Timeout length (s)', 'num', 20, 180],
    ['timer_mode', 'Game timer', 'sel', [['digital', 'DinkyKong digital clock'], ['external', 'Court timer (window)']]], ['format', 'Format', 'sel', [['5v5', 'Standard 5v5'], ['3x3', '3x3'], ['custom', 'Custom rules']]]
  ];
  const TOGGLES = [['shot_on', 'Shot clock on'], ['tenths', 'Tenths in the last minute'], ['buzzer', 'Buzzer sound at 0:00'], ['fiba_dq', 'FIBA disqualification (2 U/T fouls)'], ['tf_ot_continues', 'Overtime fouls continue last period'], ['player_scoring', 'Player-based scoring'], ['sk_clock', 'Scorekeepers can run the clock']];
  const BCAST = [['theme', 'Broadcast theme', [['electric', 'Electric DinkyKong'], ['classic', 'Classic Sports'], ['minimal', 'Minimal Broadcast'], ['tournament', 'Tournament Pro']]], ['anim_ms', 'Pop-up duration', [[2000, '2 s'], [3000, '3 s'], [4000, '4 s'], [5000, '5 s']]]];
  const DEF = Object.assign({ format: '5v5', timer_mode: 'digital', tenths: true, buzzer: true, player_scoring: true, sk_clock: true, to_game: 9, to_period: 1, preset: 'basic' }, PBB.PRESETS.basic);
  delete DEF.basic;
  delete DEF.label;

  // a match from another account (old link / other sign-in): explain and go back to the list
  function noAccess(e) {
    const c = PBB.errCode(e);
    if (c !== 'NOT_AUTHORIZED' && c !== 'NO_MATCH') { toast(PBB.errText(e), true); return; }
    const code = cur; cur = null; H = null;
    toast(c === 'NO_MATCH' ? 'Match ' + code + ' no longer exists.' : 'Match ' + code + ' belongs to another DinkyKong account. Sign in with that account to open it.', true);
    go('matches');
  }
  async function openSetup() {
    $('suMsg').textContent = '';
    if (cur) {
      try { H = await rpc('bb_host', { p_code: cur }); } catch (e) { noAccess(e); return; }
      draft = { season_id: (H.season && H.season.id) || '', title: H.title, venue: H.venue, when: H.starts_at, home: Object.assign({}, H.home), away: Object.assign({}, H.away), config: Object.assign({}, H.config), broadcast: Object.assign({}, H.broadcast),
        players: H.players.map((p) => Object.assign({}, p)) };
      $('suTitle').textContent = 'Match setup · ' + cur; $('suSave').textContent = 'Save changes'; $('fCode').value = cur;
      $('suStatus').className = 'st ' + H.status; $('suStatus').textContent = H.status.toUpperCase();
    } else if (!draft) {
      suTab('match');
      draft = { season_id: '', title: '', venue: '', when: '', home: { name: '', short: '', color: '#00e5ff', logo: '' }, away: { name: '', short: '', color: '#ff2e4d', logo: '' }, config: Object.assign({}, DEF), broadcast: { theme: 'electric', names: 'short', anim_ms: 3000 }, players: [] };
      $('suTitle').textContent = 'New match'; $('suSave').textContent = 'Create match'; $('fCode').value = ''; $('suStatus').textContent = ''; $('suStatus').className = 'st';
    }
    $('fTitle').value = draft.title || ''; $('fVenue').value = draft.venue || ''; $('fRound').value = draft.broadcast.round || ''; setTimeout(bnPrev);
    $('fWhen').value = draft.when ? new Date(new Date(draft.when).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    $('preset').innerHTML = '<option value="">Change rules…</option>' + Object.entries(PBB.PRESETS).map(([k, v]) => '<option value="' + k + '">' + v.label + '</option>').join('');
    await paintSeasonPick();
    paintTeams(); paintRules();
  }
  function suTab(k) { document.querySelectorAll('#suTabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === k)); document.querySelectorAll('#vSetup > [data-s]').forEach((el) => el.classList.toggle('hidden', el.dataset.s !== k)); $('main').scrollTop = 0; }
  $('suTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) suTab(b.dataset.s); };
  function paintTeams() {
    $('nameMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (draft.broadcast.names === 'full' ? 'full' : 'short')));
    $('teamCards').innerHTML = ['home', 'away'].map((t) => {
      const T = draft[t], other = draft[t === 'home' ? 'away' : 'home'];
      const rows = draft.players.filter((p) => p.team === t).sort((a, b) => Number(a.number) - Number(b.number));
      const st = !cur && draft.season_id ? SS.pickCache : null;
      return '<div class="p-card tcard" style="--c:' + E(T.color) + '" data-team="' + t + '">'
        + '<h2>' + (t === 'home' ? 'Home team' : 'Away team') + '<span class="tiny">' + rows.filter((p) => p.active !== false).length + ' players</span></h2>'
        + (st ? '<label class="f ss-pick">Season team<select class="in" data-steam="' + t + '"><option value="">Pick a team from ' + E(st.title) + '…</option>' + st.teams.map((x) => '<option value="' + x.id + '"' + (T.sid === x.id ? ' selected' : '') + (other.sid === x.id ? ' disabled' : '') + '>' + E(x.name) + ' · ' + x.players.length + ' players</option>').join('') + '</select></label>' : '')
        + '<div class="g2"><label class="f">Full team name<input class="in" data-k="name" maxlength="20" placeholder="Max 20 letters" value="' + E(T.name) + '" placeholder="' + (t === 'home' ? 'Team DinkyKong' : 'Red Bulls') + '"></label>'
        + '<label class="f">Initials (3–5)<input class="in" data-k="short" maxlength="5" value="' + E(T.short) + '" placeholder="' + (t === 'home' ? 'DKG' : 'RBL') + '" style="text-transform:uppercase"></label></div>'
        + '<div class="row" style="flex-wrap:wrap;gap:12px"><div class="sw-row">' + PBB.ELECTRIC.map((c) => '<button data-col="' + c + '" style="--c:' + c + '" class="' + (c === T.color ? 'on' : '') + (PBB.colorDist(c, other.color) < PBB.MIN_DIST ? ' blocked' : '') + '" title="' + c + '"></button>').join('')
        + '</div><input type="color" data-k="color" value="' + E(T.color) + '" style="width:40px;height:32px;border:0;background:none"></div>'
        + '<div class="logo-up"><span class="lg" style="' + (T.logo ? 'background-image:url(' + T.logo + ')' : '') + '"></span><label class="btn sm" style="position:relative;overflow:hidden">' + (T.logo ? 'Change logo' : 'Upload logo (optional)') + '<input type="file" accept="image/*" data-logo="1" style="position:absolute;inset:0;opacity:0"></label>' + (T.logo ? '<button class="btn sm ghost" data-nologo="1">Remove</button>' : '') + '</div>'
        + '<h3>Roster</h3><div class="tbl-wrap"><table class="rt"><thead><tr><th>#</th><th>First</th><th>Last</th><th>Display</th><th>Pos</th><th title="Starting five">Start</th><th title="Active">Act</th><th></th></tr></thead><tbody>'
        + rows.map((p) => '<tr data-pid="' + (p.id || p._tmp) + '"' + (p.active === false ? ' style="opacity:.45"' : '') + '><td class="num">' + (p.photo ? '<i class="rt-ph" style="background-image:url(' + E(p.photo) + ')"></i>' : '') + '<input class="in" data-f="number" inputmode="numeric" maxlength="2" value="' + E(p.number) + '"></td><td><input class="in" data-f="first" value="' + E(p.first) + '"></td><td><input class="in" data-f="last" value="' + E(p.last) + '"></td>'
          + '<td><input class="in" data-f="display" value="' + E(p.display) + '" placeholder="J. DELA CRUZ"></td><td><input class="in" data-f="position" maxlength="4" value="' + E(p.position) + '" style="width:56px"></td>'
          + '<td><input type="checkbox" data-f="starter"' + (p.starter ? ' checked' : '') + '></td><td><input type="checkbox" data-f="active"' + (p.active !== false ? ' checked' : '') + '></td><td><button class="btn sm ghost" data-rm="1" title="Remove">✕</button></td></tr>').join('')
        + '</tbody></table></div>'
        + '<div class="row" style="flex-wrap:wrap"><button class="btn sm" data-add="1">＋ Add player</button><button class="btn sm" data-bulk="1">Bulk add</button><span class="tiny grow">Starters: ' + rows.filter((p) => p.starter && p.active !== false).length + '/5 · the scorer picks the starting five on the remote</span></div></div>';
    }).join('');
  }
  function paintRules() {
    const c = draft.config;
    const basic = c.preset === 'basic';
    const BASIC_HIDE = ['ot_min', 'shot_full', 'shot_short', 'to_mode', 'to_h1', 'to_h2', 'to_game', 'to_period', 'to_ot', 'to_secs'];
    const toHide = { halves: ['to_game', 'to_period'], game: ['to_h1', 'to_h2', 'to_period'], period: ['to_h1', 'to_h2', 'to_game'] }[c.to_mode || 'halves'] || [];
    const shown = RULES.filter(([k]) => !(basic && BASIC_HIDE.includes(k)) && !toHide.includes(k) && !(c.shot_on === false && (k === 'shot_full' || k === 'shot_short')));
    $('presetLbl').textContent = basic ? 'Basic OBS' : ((PBB.PRESETS[c.preset] || {}).label || 'Custom rules');
    $('rules').innerHTML = shown.map(([k, l, ty, a, b]) => '<label class="f">' + l + (ty === 'sel'
      ? '<select class="in" data-r="' + k + '">' + a.map(([v, t]) => '<option value="' + v + '"' + (String(c[k]) === String(v) ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>'
      : '<input class="in" type="number" data-r="' + k + '" min="' + a + '" max="' + b + '" step="' + (k.endsWith('_min') ? '0.5' : '1') + '" value="' + E(c[k]) + '">') + '</label>').join('')
      + BCAST.map(([k, l, o]) => '<label class="f">' + l + '<select class="in" data-bc="' + k + '">' + o.map(([v, t]) => '<option value="' + v + '"' + (String(draft.broadcast[k] || '') === String(v) ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></label>').join('');
    $('rulesT').innerHTML = TOGGLES.map(([k, l]) => '<div class="toggle"><span>' + l + '</span><input type="checkbox" data-r="' + k + '"' + (c[k] !== false ? ' checked' : '') + '></div>').join('')
      + '<div class="toggle"><span>Personal fouls count as team fouls</span><input type="checkbox" data-tfk="P"' + ((c.tf_kinds || ['P', 'T', 'U', 'D']).includes('P') ? ' checked' : '') + '></div>'
      + '<div class="toggle"><span>Technical fouls count as team fouls</span><input type="checkbox" data-tfk="T"' + ((c.tf_kinds || ['P', 'T', 'U', 'D']).includes('T') ? ' checked' : '') + '></div>'
      + '<div class="toggle"><span>Unsportsmanlike / disqualifying count</span><input type="checkbox" data-tfk="U"' + ((c.tf_kinds || ['P', 'T', 'U', 'D']).includes('U') ? ' checked' : '') + '></div>';
  }
  $('preset').onchange = () => { const k = $('preset').value; const p = PBB.PRESETS[k]; if (!p) return; const x = Object.assign({}, p); delete x.label; delete x.basic;
    Object.assign(draft.config, x, { preset: k }); draft.broadcast.show_tos = k !== 'basic'; paintRules(); $('preset').value = ''; toast('Rules: ' + p.label); sendDraft(); };
  $('rules').addEventListener('change', (e) => { const el = e.target; if (el.dataset.r && el.dataset.r === 'to_mode') setTimeout(paintRules, 0); if (el.dataset.r) draft.config[el.dataset.r] = el.type === 'number' ? Number(el.value) : (/^\d+$/.test(el.value) ? Number(el.value) : el.value); if (el.dataset.bc) draft.broadcast[el.dataset.bc] = /^\d+$/.test(el.value) ? Number(el.value) : el.value; });
  $('rulesT').addEventListener('change', (e) => { const el = e.target; if (el.dataset.r) draft.config[el.dataset.r] = el.checked; if (el.dataset.r === 'shot_on') setTimeout(paintRules, 0);
    if (el.dataset.tfk) { const k = el.dataset.tfk, set = new Set(draft.config.tf_kinds || ['P', 'T', 'U', 'D']); const ks = k === 'U' ? ['U', 'D'] : [k]; ks.forEach((x) => (el.checked ? set.add(x) : set.delete(x))); draft.config.tf_kinds = [...set]; } });
  ['input', 'change', 'click'].forEach((ev) => $('vSetup').addEventListener(ev, () => setTimeout(sendDraft, 0)));
  $('nameMode').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; draft.broadcast.names = b.dataset.v; paintTeams(); };
  function bnPrev() {
    const r = $('fRound').value.trim(), e = $('fTitle').value.trim();
    $('bnR').textContent = r; $('bnE').textContent = e || (r ? '' : 'Type an event title or category to show the banner');
    const lg = draft && draft.broadcast && /^data:image\//.test(draft.broadcast.rb_logo || '') ? draft.broadcast.rb_logo : '';
    $('bnPrev').classList.toggle('empty', !r && !e && !lg); $('bnR').classList.toggle('hidden', !r);
    $('bnL').classList.toggle('hidden', !lg); if (lg) $('bnL').querySelector('img').src = lg;
    $('evlTh').innerHTML = lg ? '<img src="' + lg + '" alt="">' : '🏆'; $('evlRm').classList.toggle('hidden', !lg);
  }
  $('evlIn').onchange = async () => {
    const f = $('evlIn').files[0]; $('evlIn').value = ''; if (!f || !draft) return;
    try { draft.broadcast.rb_logo = await PBB.cropLogo(f); bnPrev(); sendDraft(); toast(cur ? 'Event logo ready — tap Save changes' : 'Event logo added'); }
    catch (x) { if (x.message !== 'CANCELLED') toast(x.message || 'Could not read that image', true); }
  };
  $('evlRm').onclick = () => { if (!draft) return; draft.broadcast.rb_logo = null; bnPrev(); sendDraft(); toast(cur ? 'Logo removed — tap Save changes' : 'Logo removed'); };
  $('fRound').addEventListener('input', () => { draft.broadcast.round = $('fRound').value.trim(); bnPrev(); });
  $('fTitle').addEventListener('input', bnPrev);
  ['fTitle', 'fVenue', 'fWhen'].forEach((id) => $(id).addEventListener('input', () => { draft.title = $('fTitle').value; draft.venue = $('fVenue').value; draft.when = $('fWhen').value ? new Date($('fWhen').value).toISOString() : ''; }));

  const findP = (id) => draft.players.find((p) => (p.id || p._tmp) === id);
  $('teamCards').addEventListener('input', (e) => {
    const card = e.target.closest('[data-team]'); if (!card) return; const t = card.dataset.team, el = e.target;
    if (el.dataset.k === 'name' || el.dataset.k === 'short') draft[t][el.dataset.k] = el.dataset.k === 'short' ? el.value.toUpperCase() : el.value;
    const tr = el.closest('tr'); if (tr && el.dataset.f && el.type !== 'checkbox') { const p = findP(tr.dataset.pid); p[el.dataset.f] = el.dataset.f === 'number' ? el.value.replace(/\D/g, '') : el.value; p._dirty = true; }
  });
  $('teamCards').addEventListener('change', async (e) => {
    const card = e.target.closest('[data-team]'); if (!card) return; const t = card.dataset.team, el = e.target;
    if (el.dataset.k === 'color') return setColor(t, el.value);
    if (el.dataset.steam) return pickSeasonTeam(t, el.value);
    if (el.dataset.logo && el.files[0]) { const f = el.files[0]; el.value = ''; try { draft[t].logo = await PBB.cropLogo(f); paintTeams(); sendDraft(); } catch (x) { if (x.message !== 'CANCELLED') toast(x.message || 'Could not read that image', true); } return; }
    const tr = el.closest('tr'); if (tr && el.dataset.f) {
      const p = findP(tr.dataset.pid);
      if (el.type === 'checkbox') p[el.dataset.f] = el.checked;
      p._dirty = true;
      if (cur && p.id) await saveRow(p);     // live match: each row saves on its own
      if (el.type === 'checkbox') paintTeams();
    }
  });
  function setColor(t, c) {
    const other = draft[t === 'home' ? 'away' : 'home'];
    if (PBB.colorDist(c, other.color) < PBB.MIN_DIST) { toast(PBB.errText('COLORS_TOO_CLOSE'), true); paintTeams(); return; }
    draft[t].color = c.toLowerCase(); paintTeams();
  }
  $('teamCards').addEventListener('click', async (e) => {
    const card = e.target.closest('[data-team]'); if (!card) return; const t = card.dataset.team, b = e.target.closest('button'); if (!b) return;
    if (b.dataset.col) return setColor(t, b.dataset.col);
    if (b.dataset.nologo) { draft[t].logo = ''; paintTeams(); return; }
    if (b.dataset.add) {
      const used = new Set(draft.players.filter((p) => p.team === t).map((p) => p.number)); let n = 4; while (used.has(String(n)) && n < 99) n++;
      const p = { _tmp: 'n' + Math.random().toString(36).slice(2), team: t, number: String(n), first: '', last: '', display: '', position: '', active: true, starter: false, _dirty: true };
      draft.players.push(p); paintTeams();
      const inp = document.querySelector('tr[data-pid="' + p._tmp + '"] [data-f="first"]'); inp && inp.focus();
      return;
    }
    if (b.dataset.rm) {
      const tr = b.closest('tr'), p = findP(tr.dataset.pid);
      if (cur && p.id) { if (!confirm('Remove #' + p.number + ' ' + (p.first + ' ' + p.last).trim() + '? Players who already have events are set inactive so the history stays correct.')) return;
        try { H = await rpc('bb_roster', { p_code: cur, p_op: 'delete', p: { id: p.id } }); draft.players = H.players.map((x) => Object.assign({}, x)); toast('Roster updated'); } catch (x) { toast(PBB.errText(x), true); } }
      else draft.players = draft.players.filter((x) => x !== p);
      paintTeams(); return;
    }
    if (b.dataset.bulk) bulk(t);
  });
  function bulk(t) {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="sheet"><h3>Bulk add · ' + (t === 'home' ? 'home' : 'away') + ' team</h3><div class="tiny">One player per line: <b>number, first name, last name, position</b> (position optional). Commas or spaces both work. Add “*” for a starter.<br>Example: <code>23 Juan Dela Cruz G *</code></div>'
      + '<textarea class="in" id="bulkTxt" placeholder="4 Mark Reyes PG *\n7 Carlo Santos\n11 Paolo Lim F"></textarea><div class="g2"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Add players</button></div></div>';
    document.body.appendChild(m);
    m.onclick = async (e) => {
      if (e.target === m || e.target.closest('[data-x]')) { m.remove(); return; }
      if (!e.target.closest('[data-ok]')) return;
      const lines = m.querySelector('#bulkTxt').value.split(/\n+/).map((x) => x.trim()).filter(Boolean);
      const used = new Set(draft.players.filter((p) => p.team === t).map((p) => p.number)); const add = []; const bad = [];
      lines.forEach((ln) => {
        const star = /\*/.test(ln); const parts = ln.replace(/\*/g, '').split(/[\s,;\t]+/).filter(Boolean);
        const num = (parts.shift() || '').replace(/^#/, '');
        if (!/^\d{1,2}$/.test(num) || used.has(num)) { bad.push(ln); return; }
        let pos = ''; if (parts.length > 1 && /^(PG|SG|SF|PF|C|G|F|G\/F|F\/C)$/i.test(parts[parts.length - 1])) pos = parts.pop().toUpperCase();
        const first = parts.shift() || '', last = parts.join(' ');
        used.add(num); add.push({ _tmp: 'n' + Math.random().toString(36).slice(2), team: t, number: num, first, last, display: '', position: pos, active: true, starter: star, _dirty: true });
      });
      draft.players.push(...add); m.remove(); paintTeams();
      if (cur) for (const p of add) await saveRow(p);
      toast(add.length + ' player' + (add.length === 1 ? '' : 's') + ' added' + (bad.length ? ' · skipped ' + bad.length + ' (bad or duplicate number)' : ''), !!bad.length);
    };
  }
  async function saveRow(p) {
    if (!/^\d{1,2}$/.test(p.number)) { toast('Jersey numbers are 0–99', true); return; }
    if (draft.players.some((x) => x !== p && x.team === p.team && x.number === p.number)) { toast(PBB.errText('DUPLICATE_JERSEY'), true); return; }
    if (H && H.status === 'live' && !p._liveOk) { if (!confirm('This match is LIVE. Save this roster change now? It updates every remote and the overlay.')) return; p._liveOk = true; }
    try {
      H = await rpc('bb_roster', { p_code: cur, p_op: 'upsert', p: { id: p.id || '', team: p.team, number: p.number, first: p.first, last: p.last, display: p.display, position: p.position, active: p.active !== false, starter: !!p.starter } });
      if (!p.id) { const np = H.players.find((x) => x.team === p.team && x.number === p.number); if (np) { p.id = np.id; delete p._tmp; } }
      p._dirty = false;
    } catch (x) { toast(PBB.errText(x), true); }
  }
  $('suCancel').onclick = () => go(cur ? 'monitor' : 'matches');
  $('suSave').onclick = async () => {
    const d = draft;
    d.title = $('fTitle').value.trim(); d.venue = $('fVenue').value.trim();
    for (const t of ['home', 'away']) { d[t].name = String(d[t].name || '').trim().slice(0, 20); if (!d[t].name) { toast('Enter both team names', true); return; } if (!d[t].short.trim()) d[t].short = d[t].name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(); }
    if (PBB.colorDist(d.home.color, d.away.color) < PBB.MIN_DIST) { toast(PBB.errText('COLORS_TOO_CLOSE'), true); return; }
    for (const t of ['home', 'away']) { const nums = d.players.filter((p) => p.team === t).map((p) => p.number); if (new Set(nums).size !== nums.length) { toast('Duplicate jersey number on the ' + t + ' team', true); return; } if (nums.some((n) => !/^\d{1,2}$/.test(n))) { toast('Jersey numbers are 0–99', true); return; } }
    $('suSave').classList.add('busy'); $('suMsg').textContent = 'Saving…';
    try {
      if (!cur) {
        if (d.season_id && (!d.home.sid || !d.away.sid) && !confirm('One of the teams is not picked from the season list, so its players will not count in the season stats. Create the game anyway?')) throw new Error('Pick both teams from the season (Teams & rosters tab).');
        const r = await rpc('bb_create', { p: { season_id: d.season_id || '', title: d.title, venue: d.venue, starts_at: d.when || '', home: d.home, away: d.away, config: d.config, broadcast: d.broadcast,
          players: d.players.map((p) => ({ team: p.team, number: p.number, first: p.first, last: p.last, display: p.display, position: p.position, active: p.active !== false, starter: !!p.starter, spid: p.spid || '', photo: p.photo || '' })) } });
        cur = r.code; draft = null; toast('Match created · ID ' + r.code); go('monitor');
      } else {
        H = await rpc('bb_update', { p_code: cur, p: { title: d.title, venue: d.venue, starts_at: d.when || '', home: d.home, away: d.away, config: d.config, broadcast: d.broadcast } });
        for (const p of d.players.filter((x) => x._dirty)) await saveRow(p);
        toast('Saved · OBS and remotes updated'); $('suMsg').textContent = '';
      }
    } catch (e) { toast(PBB.errText(e), true); $('suMsg').textContent = PBB.errText(e); }
    finally { $('suSave').classList.remove('busy'); if ($('suMsg').textContent === 'Saving…') $('suMsg').textContent = ''; }
  };

  /* ---------------- seasons ---------------- */
  const SS = { id: null, data: null, list: [], names: {}, pickCache: null, tab: 'teams', sort: 'pts', awards: null };
  async function seasonNames() {
    try { SS.list = await PBB.rpc(sb, 'bb_seasons_list', {}); SS.names = {}; SS.list.forEach((x) => { SS.names[x.id] = x.title; }); } catch (e) { SS.list = SS.list || []; }
  }
  const media = (url, anim, cls) => anim ? '<video class="' + (cls || '') + '" src="' + E(anim) + '" autoplay loop muted playsinline' + (url ? ' poster="' + E(url) + '"' : '') + '></video>' : url ? '<img class="' + (cls || '') + '" src="' + E(url) + '" alt="">' : '';
  async function openSeasons() {
    if (SS.id) return openSeason(SS.id);
    $('ssDetail').classList.add('hidden'); $('ssListView').classList.remove('hidden');
    await seasonNames();
    $('ssList').innerHTML = SS.list.map((x) => '<button class="ss-card' + (x.status === 'ended' ? ' ended' : '') + '" data-sid="' + x.id + '">'
      + '<span class="ss-c-lg">' + (media(x.logo, x.logo_anim) || '🏆') + '</span>'
      + '<span class="ss-c-tx"><b>' + E(x.title) + '</b><small>' + x.teams + ' team' + (x.teams === 1 ? '' : 's') + ' · ' + x.players + ' players · ' + x.matches + ' game' + (x.matches === 1 ? '' : 's') + (x.final ? ' (' + x.final + ' final)' : '') + '</small></span>'
      + '<span class="st ' + (x.status === 'ended' ? 'final' : 'live') + '">' + (x.status === 'ended' ? 'ENDED' : 'ACTIVE') + '</span></button>').join('')
      || '<div class="p-card m-empty"><div style="font-size:34px">🏆</div><b>No seasons yet</b><span class="tiny">Create a season, add the teams and their players (up to 15 each), then start games inside it.</span></div>';
  }
  $('ssList').onclick = (e) => { const b = e.target.closest('[data-sid]'); if (!b) return; SS.id = b.dataset.sid; SS.tab = 'teams'; setHash(); openSeason(SS.id); };
  $('ssNew').onclick = async () => {
    if (!passOk) { toast('Your Basketball pass has ended', true); openDonate(); return; }
    const t = prompt('Season title (e.g. SBAL SEASON 6 · 2026)'); if (!t || !t.trim()) return;
    try { const r = await rpc('bb_season_save', { p: { title: t.trim() } }); SS.id = r.id; SS.tab = 'teams'; setHash(); paintSeason(r); toast('Season created · add the teams'); } catch (x) { toast(PBB.errText(x), true); }
  };
  async function openSeason(id) {
    try { paintSeason(await PBB.rpc(sb, 'bb_season_get', { p_id: id })); }
    catch (e) { toast(PBB.errText(e), true); SS.id = null; setHash(); openSeasons(); }
  }
  function paintSeason(d) {
    SS.data = d; SS.awards = null;
    $('ssListView').classList.add('hidden'); $('ssDetail').classList.remove('hidden');
    const ended = d.status === 'ended';
    $('ssDetail').classList.toggle('ss-ended', ended);
    if (document.activeElement !== $('ssTitle')) $('ssTitle').value = d.title;
    $('ssTitle').disabled = ended;
    $('ssKicker').textContent = ended ? 'SEASON · ENDED ' + new Date(d.ended_at).toLocaleDateString() : 'SEASON · ACTIVE';
    const np = d.teams.reduce((a, t) => a + t.players.length, 0);
    $('ssMeta').textContent = d.teams.length + ' teams · ' + np + ' players · ' + d.matches.length + ' games';
    $('ssLogoIn').innerHTML = media(d.logo, d.logo_anim) || '🏆';
    $('ssEnd').textContent = ended ? 'Reopen season' : 'End season';
    document.querySelectorAll('#ssTabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === SS.tab));
    document.querySelectorAll('#ssDetail [data-ss]').forEach((el) => el.classList.toggle('hidden', el.dataset.ss !== SS.tab));
    paintSeasonTeams(); paintSeasonGames(); paintSeasonStats();
  }
  $('ssTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; SS.tab = b.dataset.s; paintSeason(SS.data); };
  $('ssBack').onclick = () => { SS.id = null; SS.data = null; setHash(); openSeasons(); };
  $('ssTitle').onchange = async () => { const t = $('ssTitle').value.trim(); if (!t || !SS.data || t === SS.data.title) return; try { paintSeason(await rpc('bb_season_save', { p: { id: SS.data.id, title: t } })); toast('Season title saved'); } catch (x) { toast(PBB.errText(x), true); } };
  $('ssEnd').onclick = async () => {
    const d = SS.data; if (!d) return; const ending = d.status !== 'ended';
    if (ending && !confirm('End "' + d.title + '"?\n\nThe season becomes read-only: no new games, teams or players. Its standings, stats and awards stay saved. You can reopen it later.')) return;
    try { paintSeason(await rpc('bb_season_save', { p: { id: d.id, status: ending ? 'ended' : 'active' } })); toast(ending ? 'Season ended · stats saved' : 'Season reopened'); } catch (x) { toast(PBB.errText(x), true); }
  };
  // STRICT delete: type the season title
  $('ssDel').onclick = () => {
    const d = SS.data; if (!d) return;
    const np = d.teams.reduce((a, t) => a + t.players.length, 0);
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="sheet ss-delsheet"><h3 style="color:var(--danger)">Delete season permanently</h3>'
      + '<p class="muted" style="margin:0">This erases <b>' + E(d.title) + '</b> and everything in it. It cannot be undone.</p>'
      + '<ul class="ss-dl"><li><b>' + d.matches.length + '</b> games with all scores, play-by-play and stats</li><li><b>' + d.teams.length + '</b> teams and <b>' + np + '</b> players (photos too)</li><li>Standings and <b>' + (d.awards || []).length + '</b> awards</li><li>The season logo</li></ul>'
      + '<label class="f">Type the season title to confirm<input class="in" id="ssDelIn" autocomplete="off" spellcheck="false" placeholder="' + E(d.title) + '"></label>'
      + '<div class="g2"><button class="btn" data-x>Cancel</button><button class="btn danger" id="ssDelGo" disabled>Delete forever</button></div></div>';
    document.body.appendChild(m);
    const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const inp = m.querySelector('#ssDelIn'), go2 = m.querySelector('#ssDelGo'); inp.focus();
    inp.oninput = () => { go2.disabled = norm(inp.value) !== norm(d.title); };
    m.onclick = async (e) => {
      if (e.target === m || e.target.closest('[data-x]')) { m.remove(); return; }
      if (e.target !== go2 || go2.disabled) return;
      go2.classList.add('busy');
      try {
        const r = await rpc('bb_season_delete', { p_id: d.id, p_title: inp.value });
        await PBB.removeFolder(sb, d.owner + '/s/' + d.id);
        m.remove(); SS.id = null; SS.data = null; setHash(); toast('Season deleted · ' + r.matches + ' games removed'); openSeasons();
      } catch (x) { toast(PBB.errText(x), true); go2.classList.remove('busy'); }
    };
  };
  // season logo: image / GIF / video → WebP poster + WebM loop
  $('ssLogo').onclick = () => { if (SS.data && SS.data.status === 'ended') { toast(PBB.errText('SEASON_ENDED'), true); return; } $('ssLogoIn2').click(); };
  $('ssLogoIn2').onchange = async () => {
    const f = $('ssLogoIn2').files[0]; $('ssLogoIn2').value = ''; const d = SS.data; if (!f || !d) return;
    if (f.size > 60 * 1024 * 1024) { toast('That file is too big (max 60 MB)', true); return; }
    const msg = $('ssLogoMsg'), old = msg.textContent; $('ssLogo').classList.add('busy');
    try {
      msg.textContent = /^video|gif/.test(f.type) ? 'Converting to WebM… keep this tab open' : 'Preparing the logo…';
      const r = await PBB.seasonLogo(f, (p) => { msg.textContent = 'Converting to WebM… ' + Math.round(p * 100) + '%'; });
      msg.textContent = 'Uploading…';
      const poster = await PBB.upload(sb, 's/' + d.id + '/logo', r.poster);
      const anim = r.anim ? await PBB.upload(sb, 's/' + d.id + '/logo-anim', r.anim) : null;
      const prev = [d.logo, d.logo_anim];
      paintSeason(await rpc('bb_season_save', { p: { id: d.id, logo: poster, logo_anim: anim } }));
      PBB.removeMedia(sb, prev);
      toast(r.anim ? 'Animated logo ready · ' + Math.round(r.anim.size / 1024) + ' KB WebM' : (/^video|gif/.test(f.type) ? 'This browser cannot make WebM — saved a still logo (use Chrome or Edge for animation)' : 'Season logo saved'));
      msg.textContent = old;
    } catch (x) { toast(x.message || PBB.errText(x), true); msg.textContent = old; }
    finally { $('ssLogo').classList.remove('busy'); }
  };

  /* teams & players (max 15 per team; each change saves right away) */
  function paintSeasonTeams() {
    const d = SS.data, ro = d.status === 'ended';
    $('ssTeamForm').classList.toggle('hidden', ro);
    $('ssTeams').innerHTML = d.teams.map((t) => {
      const full = t.players.length >= 15;
      return '<div class="p-card ss-team" style="--c:' + E(t.color) + '" data-tid="' + t.id + '">'
        + '<div class="sst-head"><label class="sst-lg' + (ro ? ' ro' : '') + '" title="Team logo">' + (t.logo ? '<img src="' + E(t.logo) + '" alt="">' : '<span>' + E(t.short || '?') + '</span>') + (ro ? '' : '<input type="file" accept="image/*" data-tlogo hidden>') + '</label>'
        + '<input class="in sst-nm" data-tf="name" maxlength="20" value="' + E(t.name) + '"' + (ro ? ' disabled' : '') + '><input class="in sst-sh" data-tf="short" maxlength="5" value="' + E(t.short) + '"' + (ro ? ' disabled' : '') + '>'
        + '<input type="color" class="ss-col" data-tf="color" value="' + E(t.color) + '"' + (ro ? ' disabled' : '') + '>'
        + '<span class="sst-cnt' + (full ? ' full' : '') + '">' + t.players.length + '/15</span>' + (ro ? '' : '<button class="btn sm ghost" data-tdel title="Remove team">✕</button>') + '</div>'
        + '<div class="sst-pl">' + t.players.map((p) => '<div class="ssp" data-pid="' + p.id + '">'
          + '<label class="ssp-ph' + (ro ? ' ro' : '') + '" title="Player photo">' + (p.photo ? '<img src="' + E(p.photo) + '" alt="">' : '<span>📷</span>') + (ro ? '' : '<input type="file" accept="image/*" data-pphoto hidden>') + '</label>'
          + '<input class="in ssp-no" data-pf="number" inputmode="numeric" maxlength="2" value="' + E(p.number) + '"' + (ro ? ' disabled' : '') + '>'
          + '<input class="in" data-pf="first" placeholder="First name" value="' + E(p.first) + '"' + (ro ? ' disabled' : '') + '>'
          + '<input class="in" data-pf="last" placeholder="Last name" value="' + E(p.last) + '"' + (ro ? ' disabled' : '') + '>'
          + '<input class="in ssp-pos" data-pf="position" maxlength="4" placeholder="Pos" value="' + E(p.position) + '"' + (ro ? ' disabled' : '') + '>'
          + (ro ? '' : '<button class="btn sm ghost" data-pdel title="Remove player">✕</button>') + '</div>').join('')
        + (ro || full ? '' : '<form class="ssp new" data-padd autocomplete="off"><span class="ssp-ph ph0">＋</span><input class="in ssp-no" name="number" inputmode="numeric" maxlength="2" placeholder="#"><input class="in" name="first" placeholder="First name"><input class="in" name="last" placeholder="Last name"><input class="in ssp-pos" name="position" maxlength="4" placeholder="Pos"><button class="btn sm primary" type="submit">Add</button></form>')
        + '</div>' + (full ? '<div class="tiny" style="margin-top:6px">Roster full (15 players).</div>' : '') + '</div>';
    }).join('') || '<div class="p-card m-empty"><b>No teams yet</b><span class="tiny">Add every team of the season above, then their players (up to 15 each) with jersey number and an optional photo.</span></div>';
  }
  $('ssTeamForm').onsubmit = async (e) => {
    e.preventDefault(); const d = SS.data; const name = $('ssTName').value.trim(); if (!name) { toast('Type the team name', true); return; }
    try { paintSeason(await rpc('bb_season_team', { p: { season_id: d.id, name, short: $('ssTShort').value.trim(), color: $('ssTColor').value } }));
      $('ssTName').value = ''; $('ssTShort').value = ''; $('ssTColor').value = PBB.ELECTRIC[(SS.data.teams.length) % PBB.ELECTRIC.length]; toast('Team added · now add its players');
      const last = document.querySelector('#ssTeams .ss-team:last-child [data-padd] [name="number"]'); last && last.focus(); } catch (x) { toast(PBB.errText(x), true); }
  };
  const seasonTeamOf = (el) => SS.data.teams.find((t) => t.id === el.closest('[data-tid]').dataset.tid);
  $('ssTeams').addEventListener('change', async (e) => {
    const el = e.target, card = el.closest('[data-tid]'); if (!card) return; const t = seasonTeamOf(el);
    try {
      if (el.dataset.tf) { const v = el.dataset.tf === 'short' ? el.value.trim().toUpperCase() : el.value.trim(); SS.data = await rpc('bb_season_team', { p: { id: t.id, [el.dataset.tf]: v } }); if (el.dataset.tf === 'color') card.style.setProperty('--c', v); return; }
      if (el.matches('[data-tlogo]') && el.files[0]) {
        const f = el.files[0]; el.value = ''; toast('Uploading logo…');
        const url = await PBB.upload(sb, 's/' + SS.data.id + '/team-' + t.id.slice(0, 8), await PBB.toWebp(f, { fit: 'contain', sizes: [384, 320, 256] }));
        const prev = t.logo; paintSeason(await rpc('bb_season_team', { p: { id: t.id, logo: url } })); PBB.removeMedia(sb, [prev]); toast('Team logo saved'); return;
      }
      const row = el.closest('[data-pid]');
      if (row && el.matches('[data-pphoto]') && el.files[0]) {
        const f = el.files[0]; el.value = ''; row.classList.add('busy');
        const blob = await PBB.toWebp(f, { fit: 'top', maxBytes: 500 * 1024 });
        const url = await PBB.upload(sb, 's/' + SS.data.id + '/p-' + row.dataset.pid.slice(0, 8), blob);
        const prev = (t.players.find((p) => p.id === row.dataset.pid) || {}).photo;
        paintSeason(await rpc('bb_season_player', { p: { id: row.dataset.pid, photo: url } })); PBB.removeMedia(sb, [prev]);
        toast('Photo saved · WebP ' + Math.round(blob.size / 1024) + ' KB'); return;
      }
      if (row && el.dataset.pf) {
        let v = el.value.trim(); if (el.dataset.pf === 'number') { v = v.replace(/\D/g, ''); if (!/^\d{1,2}$/.test(v)) { toast('Jersey numbers are 0–99', true); return; } }
        SS.data = await rpc('bb_season_player', { p: { id: row.dataset.pid, [el.dataset.pf]: v } }); el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 900);
      }
    } catch (x) { toast(x.message && !/[A-Z_]{6,}/.test(x.message) ? x.message : PBB.errText(x), true); paintSeason(await PBB.rpc(sb, 'bb_season_get', { p_id: SS.data.id })); }
  });
  $('ssTeams').addEventListener('submit', async (e) => {
    const fm = e.target.closest('[data-padd]'); if (!fm) return; e.preventDefault();
    const t = seasonTeamOf(fm), v = (n) => fm.elements[n].value.trim();
    const num = v('number').replace(/\D/g, ''); if (!/^\d{1,2}$/.test(num)) { toast('Type the jersey number (0–99)', true); fm.elements.number.focus(); return; }
    if (!v('first') && !v('last')) { toast('Type the player name', true); fm.elements.first.focus(); return; }
    try { paintSeason(await rpc('bb_season_player', { p: { team_id: t.id, number: num, first: v('first'), last: v('last'), position: v('position') } }));
      const nf = document.querySelector('#ssTeams [data-tid="' + t.id + '"] [data-padd] [name="number"]'); nf && nf.focus(); } catch (x) { toast(PBB.errText(x), true); }
  });
  $('ssTeams').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const t = seasonTeamOf(b);
    if (b.matches('[data-tdel]')) { if (!confirm('Remove ' + t.name + ' and its ' + t.players.length + ' players from the season?')) return;
      try { paintSeason(await rpc('bb_season_team_delete', { p_id: t.id })); PBB.removeMedia(sb, [t.logo].concat(t.players.map((p) => p.photo))); toast('Team removed'); } catch (x) { toast(PBB.errText(x), true); } }
    if (b.matches('[data-pdel]')) { const id = b.closest('[data-pid]').dataset.pid, p = t.players.find((x) => x.id === id);
      if (!confirm('Remove #' + p.number + ' ' + (p.first + ' ' + p.last).trim() + ' from ' + t.name + '? Games already played keep their stats.')) return;
      try { paintSeason(await rpc('bb_season_player_delete', { p_id: id })); PBB.removeMedia(sb, [p.photo]); } catch (x) { toast(PBB.errText(x), true); } }
  });

  /* games */
  function paintSeasonGames() {
    const d = SS.data;
    $('ssNewGame').classList.toggle('hidden', d.status === 'ended');
    $('ssGames').innerHTML = d.matches.map((m) => {
      const sc = m.score || { home: 0, away: 0 }, when = new Date(m.starts_at || m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return '<div class="mcard"><div class="tt"><span>' + E(m.round || m.title || 'Game') + (m.venue ? ' · ' + E(m.venue) : '') + '</span><span class="st ' + m.status + '">' + m.status.toUpperCase() + '</span></div>'
        + '<div class="vs"><span style="color:' + E(m.home.color) + '">' + E(m.home.name) + '</span><b>' + sc.home + ' – ' + sc.away + '</b><span style="color:' + E(m.away.color) + '">' + E(m.away.name) + '</span></div>'
        + '<div class="tiny">' + when + ' · ID ' + m.code + '</div>'
        + '<div class="row" style="flex-wrap:wrap"><button class="btn sm cyan" data-o="monitor" data-c="' + m.code + '">OBS Monitor</button><button class="btn sm" data-o="setup" data-c="' + m.code + '">Setup</button><button class="btn sm" data-o="summary" data-c="' + m.code + '">Stats</button></div></div>';
    }).join('') || '<div class="m-empty"><div style="font-size:34px">🏀</div><b>No games yet</b><span class="tiny">Start a game in this season: pick the two teams and their rosters load automatically.</span></div>';
  }
  $('ssGames').onclick = (e) => { const b = e.target.closest('button[data-c]'); if (!b) return; cur = b.dataset.c; H = null; go(b.dataset.o); };
  $('ssNewGame').onclick = () => {
    if (!passOk) { toast('Your Basketball pass has ended', true); openDonate(); return; }
    const d = SS.data; if (d.teams.length < 2) { toast('Add at least two teams first', true); SS.tab = 'teams'; paintSeason(d); return; }
    cur = null; H = null; draft = null; SS.newFor = d.id; go('setup');
  };

  /* standings, leaders, awards */
  const LEAD = [['gp', 'GP'], ['pts', 'PTS'], ['ppg', 'PPG'], ['m2', '2PT'], ['m3', '3PT'], ['m1', 'FT'], ['f', 'FOULS'], ['reb', 'REB'], ['ast', 'AST']];
  function seasonPlayers() {
    const d = SS.data, st = (d.stats && d.stats.players) || {};
    return d.teams.flatMap((t) => t.players.map((p) => { const s2 = Object.assign({ gp: 0, pts: 0, m1: 0, m2: 0, m3: 0, f: 0, reb: 0, ast: 0 }, st[p.id] || {}); s2.ppg = s2.gp ? Math.round(s2.pts / s2.gp * 10) / 10 : 0; return { p, t, s: s2 }; }));
  }
  function paintSeasonStats() {
    const d = SS.data, ts = (d.stats && d.stats.teams) || {};
    const rows = d.teams.map((t) => Object.assign({ t }, { gp: 0, w: 0, l: 0, pf: 0, pa: 0 }, ts[t.id] || {})).sort((a, b) => b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa) || a.l - b.l);
    $('ssStand').innerHTML = rows.length ? '<table class="bx-t ss-tbl"><thead><tr><th>#</th><th class="pl">Team</th><th>GP</th><th>W</th><th>L</th><th>PF</th><th>PA</th><th>DIFF</th></tr></thead><tbody>'
      + rows.map((r, i) => '<tr><td class="no">' + (i + 1) + '</td><td class="pl"><i class="ss-dot" style="background:' + E(r.t.color) + '"></i>' + E(r.t.name) + '</td><td>' + r.gp + '</td><td class="pt">' + r.w + '</td><td>' + r.l + '</td><td>' + r.pf + '</td><td>' + r.pa + '</td><td>' + (r.pf - r.pa > 0 ? '+' : '') + (r.pf - r.pa) + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="empty-s">Add teams to see the standings.</div>';
    const list = seasonPlayers().sort((a, b) => (b.s[SS.sort] || 0) - (a.s[SS.sort] || 0) || b.s.pts - a.s.pts);
    $('ssLead').innerHTML = list.length ? '<table class="bx-t ss-tbl"><thead><tr><th>#</th><th class="pl">Player</th><th class="pl">Team</th>' + LEAD.map(([k, l]) => '<th data-sort="' + k + '" class="srt' + (SS.sort === k ? ' on' : '') + '">' + l + '</th>').join('') + '</tr></thead><tbody>'
      + list.map((x) => '<tr><td class="no">' + E(x.p.number) + '</td><td class="pl">' + (x.p.photo ? '<i class="rt-ph" style="background-image:url(' + E(x.p.photo) + ')"></i>' : '') + E(PBB.playerName(x.p)) + '</td><td class="pl" style="color:' + E(x.t.color) + '">' + E(x.t.short || x.t.name) + '</td>'
        + LEAD.map(([k]) => '<td class="' + (k === SS.sort ? 'pt' : '') + (x.s[k] ? '' : ' z') + '">' + (x.s[k] || 0) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
      : '<div class="empty-s">No players yet.</div>';
    paintAwards();
  }
  $('ssLead').onclick = (e) => { const th = e.target.closest('[data-sort]'); if (!th) return; SS.sort = th.dataset.sort; paintSeasonStats(); };
  const AWARD_IDEAS = ['MVP', 'Finals MVP', 'Best Scorer', 'Best Defensive Player', 'Rookie of the Season', 'Most Improved Player', 'Sixth Man', 'Mythical Five', 'Sportsmanship Award', 'Champion Team'];
  function paintAwards() {
    const d = SS.data; if (!SS.awards) SS.awards = JSON.parse(JSON.stringify(d.awards || []));
    const pls = seasonPlayers().sort((a, b) => b.s.pts - a.s.pts);
    const opt = (a) => '<option value="">— pick player or team —</option>' + d.teams.map((t) => '<optgroup label="' + E(t.name) + '"><option value="t:' + t.id + '"' + (a.team === t.id && !a.player ? ' selected' : '') + '>🏀 ' + E(t.name) + ' (team)</option>'
      + pls.filter((x) => x.t.id === t.id).map((x) => '<option value="p:' + x.p.id + '"' + (a.player === x.p.id ? ' selected' : '') + '>#' + E(x.p.number) + ' ' + E(PBB.playerName(x.p)) + ' · ' + x.s.pts + ' pts / ' + x.s.gp + ' gp</option>').join('') + '</optgroup>').join('');
    const who = (a) => { const pl = a.player && pls.find((x) => x.p.id === a.player), tm = d.teams.find((t) => t.id === (a.team || (pl && pl.t.id))); return pl ? { ph: pl.p.photo, nm: PBB.playerName(pl.p), sub: '#' + pl.p.number + ' · ' + (tm ? tm.name : ''), c: tm ? tm.color : '' } : tm ? { ph: tm.logo, nm: tm.name, sub: 'Team', c: tm.color } : null; };
    $('ssAwards').innerHTML = '<div class="aw-list">' + SS.awards.map((a, i) => { const w = who(a);
      return '<div class="aw" data-i="' + i + '" style="--c:' + (w && w.c ? E(w.c) : 'var(--line2)') + '"><span class="aw-ph">' + (w && w.ph ? '<img src="' + E(w.ph) + '" alt="">' : '🏆') + '</span>'
        + '<span class="aw-f"><input class="in aw-t" data-af="title" maxlength="40" value="' + E(a.title) + '" placeholder="Award"><select class="in" data-af="who">' + opt(a) + '</select><input class="in" data-af="note" maxlength="80" value="' + E(a.note || '') + '" placeholder="Note (optional) e.g. 21.4 PPG"></span>'
        + '<button class="btn sm ghost" data-arm title="Remove">✕</button></div>'; }).join('') + '</div>'
      + '<div class="aw-ideas">' + AWARD_IDEAS.filter((x) => !SS.awards.some((a) => a.title === x)).map((x) => '<button class="chip" data-aidea="' + E(x) + '">＋ ' + E(x) + '</button>').join('') + '<button class="chip" data-aidea="">＋ Custom award</button></div>'
      + '<div class="row"><span class="tiny grow" id="awMsg">' + (SS.awards.length ? '' : 'Add awards, then pick the winners from the season stats.') + '</span><button class="btn primary sm" id="awSave">Save awards</button></div>';
  }
  $('ssAwards').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.aidea != null) { SS.awards.push({ title: b.dataset.aidea || 'Award' }); paintAwards(); const ins = $('ssAwards').querySelectorAll('.aw-t'); const t = ins[ins.length - 1]; if (!b.dataset.aidea && t) { t.select(); t.focus(); } $('awMsg').textContent = 'Not saved yet'; return; }
    if (b.matches('[data-arm]')) { SS.awards.splice(Number(b.closest('[data-i]').dataset.i), 1); paintAwards(); $('awMsg').textContent = 'Not saved yet'; return; }
    if (b.id === 'awSave') saveAwards();
  });
  $('ssAwards').addEventListener('change', (e) => {
    const el = e.target, row = el.closest('[data-i]'); if (!row) return; const a = SS.awards[Number(row.dataset.i)];
    if (el.dataset.af === 'who') { const v = el.value; a.player = v.startsWith('p:') ? v.slice(2) : undefined; a.team = v.startsWith('t:') ? v.slice(2) : (a.player ? (seasonPlayers().find((x) => x.p.id === a.player) || { t: {} }).t.id : undefined); paintAwards(); }
    else a[el.dataset.af] = el.value;
    $('awMsg').textContent = 'Not saved yet';
  });
  async function saveAwards() {
    try { const r = await rpc('bb_season_save', { p: { id: SS.data.id, awards: SS.awards } }); SS.data = r; SS.awards = null; paintAwards(); toast('Awards saved'); } catch (x) { toast(PBB.errText(x), true); }
  }

  /* match setup: pick the season, then each team from the season list (roster + photos load) */
  async function paintSeasonPick() {
    if (!SS.list.length) await seasonNames();
    if (SS.newFor && !cur && draft && !draft.season_id) { draft.season_id = SS.newFor; SS.newFor = null; }
    const sel = $('fSeason');
    if (cur) {
      const t = H && H.season ? H.season.title : '';
      sel.innerHTML = '<option value="">' + (t ? '🏆 ' + E(t) : 'No season · single game') + '</option>'; sel.disabled = true;
    } else {
      sel.disabled = false;
      sel.innerHTML = '<option value="">No season · single game</option>' + SS.list.filter((x) => x.status !== 'ended').map((x) => '<option value="' + x.id + '"' + (draft.season_id === x.id ? ' selected' : '') + '>🏆 ' + E(x.title) + ' · ' + x.teams + ' teams</option>').join('');
    }
    SS.pickCache = null;
    if (!cur && draft.season_id) {
      try { SS.pickCache = await PBB.rpc(sb, 'bb_season_get', { p_id: draft.season_id }); if (!draft.title) { draft.title = SS.pickCache.title; $('fTitle').value = draft.title; bnPrev(); } } catch (e) { draft.season_id = ''; }
    }
  }
  $('fSeason').onchange = async () => {
    if (!draft || cur) return;
    const prev = draft.season_id; draft.season_id = $('fSeason').value;
    if (!draft.season_id && prev) { ['home', 'away'].forEach((t) => { delete draft[t].sid; }); }
    if (draft.season_id) { const t = SS.list.find((x) => x.id === draft.season_id); if (t && (!draft.title || draft.title === (SS.pickCache && SS.pickCache.title))) draft.title = t.title; $('fTitle').value = draft.title; }
    await paintSeasonPick(); paintTeams(); sendDraft();
    if (draft.season_id) toast('Now pick both teams in Teams & rosters');
  };
  function pickSeasonTeam(t, id) {
    const st = SS.pickCache; if (!st) return;
    const x = st.teams.find((y) => y.id === id);
    if (!x) { delete draft[t].sid; paintTeams(); return; }
    const other = draft[t === 'home' ? 'away' : 'home'];
    let color = x.color;
    if (PBB.colorDist(color, other.color) < PBB.MIN_DIST) { color = PBB.ELECTRIC.slice().sort((a, b) => PBB.colorDist(b, other.color) - PBB.colorDist(a, other.color))[0]; toast(x.name + ' uses ' + color + ' in this game (its colour is too close to the other team)'); }
    draft[t] = { name: x.name, short: x.short, color, logo: x.logo || '', sid: x.id };
    draft.players = draft.players.filter((p) => p.team !== t).concat(x.players.map((p) => ({ _tmp: 'n' + Math.random().toString(36).slice(2), team: t, number: p.number, first: p.first, last: p.last, display: '', position: p.position, photo: p.photo || '', spid: p.id, active: true, starter: false, _dirty: true })));
    paintTeams(); sendDraft();
  }

  /* ---------------- monitor ---------------- */
  async function openMonitor() {
    try { H = await rpc('bb_host', { p_code: cur }); } catch (e) { noAccess(e); return; }
    const base = location.href.replace(/[^/]*$/, '');
    const obs = base + 'bb-obs.html?m=' + cur + '&k=' + H.view_key;
    const board = base + 'bb-board.html?m=' + cur + '&k=' + H.view_key; $('boardUrl').value = board; $('boardOpen').href = board;
    $('obsUrl').value = obs; $('moTitle').textContent = (H.title || 'Match') + ' · ' + cur;
    const bg = [...$('bgSeg').children].find((b) => b.classList.contains('on')).dataset.v;
    $('moFrame').src = obs + '&preview=' + bg;
    $('pin').textContent = H.pin; $('multi').checked = H.allow_multi; $('skClock').checked = H.config.sk_clock !== false; $('moLock').checked = !!H.locked;
    $('hostRemote').href = 'bb-remote.html?m=' + cur + '&host=1';
    drawQrs(base);
    if (!conn || conn._code !== cur) { conn && conn.close(); conn = PBB.connect({ code: cur, key: H.view_key, signedIn: true, onSnap: paintLive, onStatus: liveStatus }); conn._code = cur; }
    else if (conn.snap) paintLive(conn.snap);
    paintDevices(); clearInterval(devT); devT = setInterval(async () => { if (view !== 'monitor') return; try { H = await rpc('bb_host', { p_code: cur }); paintDevices(); } catch (e) {} }, 15000);
  }
  function liveStatus(s) { const el = $('moLive'); el.className = 'r-live ' + (s === 'live' ? '' : s === 'connecting' ? 'wait' : 'off'); el.querySelector('span').textContent = s === 'live' ? 'LIVE SYNC' : s.toUpperCase(); }
  function paintLive(s) {
    const d = s.derived, tl = (t) => Math.max(0, d.tos.allow - d.tos[t]);
    const side = (t) => '<span class="mbs-t" style="--c:' + s[t].color + '">' + (s[t].logo ? '<img src="' + s[t].logo + '" alt="">' : '<i></i>') + '<span><b>' + E(s[t].short || s[t].name) + '</b><small>F ' + d.fouls[t] + ' · TO ' + tl(t) + '</small></span></span>';
    $('moScore').innerHTML = side('home') + '<span class="mbs-mid"><span class="mbs-per">' + E(PBB.periodLabel(d.period, s.config.periods, true)) + '</span><b>' + d.score.home + '<em>–</em>' + d.score.away + '</b><span class="st ' + s.status + '">' + s.status.toUpperCase() + '</span></span>' + side('away').replace('class="mbs-t"', 'class="mbs-t r"');
    $('moFinal').querySelector('b').textContent = s.status === 'final' ? 'Reopen match' : 'End match';
    $('moFinal').querySelector('small').textContent = s.status === 'final' ? 'Back to live' : 'Save as FINAL';
    $('moPrev').classList.toggle('at-top', (s.broadcast || {}).pos === 'top');
    if (H) { H.status = s.status; H.locked = s.locked; } $('moLock').checked = !!s.locked; look.paint();
    if (view === 'summary') openSummarySoon();
  }
  function paintDevices() {
    const list = (H.device_list || []).filter((d) => !d.revoked);
    $('devs').innerHTML = list.map((d) => { const on = Date.now() - Date.parse(d.last_seen) < 120000;
      return '<div class="dev"><span><span class="dot' + (on ? ' on' : '') + '"></span><b>' + E(d.name || d.role) + '</b><small>' + E(d.role) + ' · paired ' + new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · last action ' + new Date(d.last_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</small></span><button class="btn sm danger" data-rv="' + d.id + '">Remove</button></div>'; }).join('')
      || '<div class="tiny">No phones paired yet.</div>';
    $('devCnt').textContent = list.length ? String(list.length) : '';
  }
  async function drawQrs(base) {
    try { await PBCommon.loadScript(PBCommon.LIBS.qr); } catch (e) { $('qrs').innerHTML = '<div class="tiny">QR library could not load.</div>'; return; }
    $('qrs').innerHTML = [['scorekeeper', 'Referee'], ['clock', 'Timekeeper']].map(([r, l]) => {
      const url = base + 'bb-remote.html?m=' + cur + '&r=' + r; const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
      return '<div class="qr">' + qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) + '<b>' + l + '</b><a class="tiny" href="' + url + '" target="_blank" rel="noopener" style="color:#3a4466">open link</a></div>';
    }).join('');
  }
  $('bgSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; [...$('bgSeg').children].forEach((x) => x.classList.toggle('on', x === b)); $('moFrame').src = $('obsUrl').value + '&preview=' + b.dataset.v; };
  $('zoomSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; [...$('zoomSeg').children].forEach((x) => x.classList.toggle('on', x === b)); $('moPrev').classList.toggle('zoom-lt', b.dataset.z === 'lt'); };
  $('moTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; [...$('moTabs').children].forEach((x) => x.classList.toggle('on', x === b)); document.querySelectorAll('#vMonitor .mo-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.t !== b.dataset.t)); };
  $('copyObs2').onclick = () => $('copyObs').click();
  // tab-bar link: always points at the current match (opens a quick check of the match first)
  $('boardOpen').addEventListener('click', async (e) => {
    if (!cur) { e.preventDefault(); toast('Pick a match first — then open its venue scoreboard.'); return; }
    if (!($('boardOpen').getAttribute('href') || '').includes('m=' + cur + '&')) {
      e.preventDefault();
      try { const h = await rpc('bb_host', { p_code: cur }); const u = location.href.replace(/[^/]*$/, '') + 'bb-board.html?m=' + cur + '&k=' + h.view_key; $('boardOpen').href = u; window.open(u, '_blank', 'noopener'); } catch (x) { noAccess(x); }
    }
  });
  $('copyBoard').onclick = async () => { try { await navigator.clipboard.writeText($('boardUrl').value); toast('Venue scoreboard link copied'); } catch (e) { $('boardUrl').select(); document.execCommand('copy'); toast('Copied'); } };
  $('copyObs').onclick = async () => { try { await navigator.clipboard.writeText($('obsUrl').value); toast('Browser Source URL copied'); } catch (e) { $('obsUrl').select(); document.execCommand('copy'); toast('Copied'); } };
  $('newPin').onclick = async () => { if (!confirm('Make a new PIN? Phones already paired stay connected; new phones need the new PIN.')) return; try { H = await rpc('bb_update', { p_code: cur, p: { new_pin: true } }); $('pin').textContent = H.pin; toast('New PIN ready'); } catch (e) { toast(PBB.errText(e), true); } };
  $('multi').onchange = async () => { try { H = await rpc('bb_update', { p_code: cur, p: { allow_multi: $('multi').checked } }); } catch (e) { toast(PBB.errText(e), true); } };
  $('skClock').onchange = async () => { try { H = await rpc('bb_update', { p_code: cur, p: { config: { sk_clock: $('skClock').checked } } }); } catch (e) { toast(PBB.errText(e), true); } };
  $('devs').onclick = async (e) => { const b = e.target.closest('[data-rv]'); if (!b) return; if (!confirm('Remove this device? It can no longer control the match.')) return; try { H = await rpc('bb_revoke', { p_code: cur, p_device: b.dataset.rv }); paintDevices(); toast('Device removed'); } catch (x) { toast(PBB.errText(x), true); } };
  $('revokeAll').onclick = async () => { if (!confirm('Remove ALL paired phones from this match?')) return; try { H = await rpc('bb_revoke', { p_code: cur, p_device: null }); paintDevices(); toast('All devices removed'); } catch (x) { toast(PBB.errText(x), true); } };
  const hostAct = async (type, data, msg) => { try { await conn.act(type, data); msg && toast(msg); } catch (e) { toast(e.message === 'OFFLINE' ? 'Not connected' : PBB.errText(e), true); } };
  const look = PBB.lookPanel($('moLook'), () => conn && conn.snap && conn.snap.broadcast, (patch) => hostAct('broadcast', { patch }));
  $('moReset').onclick = () => hostAct('overlay', { op: 'reset' }, 'Overlay reset');
  $('moHide').onclick = () => hostAct('overlay', { op: 'hide' }, 'Overlay hidden');
  $('moShow').onclick = () => hostAct('overlay', { op: 'show' }, 'Overlay visible');
  $('moClear').onclick = () => hostAct('overlay', { op: 'clear' }, 'Announcement cleared');
  $('moPause').onclick = () => hostAct('clock', { op: 'emergency' }, 'Clock paused');
  $('moLock').onchange = () => hostAct('lock', { on: $('moLock').checked }, $('moLock').checked ? 'Broadcast settings locked' : 'Unlocked');
  $('moFinal').onclick = () => {
    const s = conn && conn.snap; if (!s) return;
    if (s.status === 'final') { if (confirm('Reopen this match? Recorded in the audit trail.')) hostAct('reopen', {}, 'Match reopened'); return; }
    if (confirm('End the match as FINAL?\n\n' + s.home.name + ' ' + s.derived.score.home + ' — ' + s.derived.score.away + ' ' + s.away.name)) hostAct('final', {}, 'Final saved');
  };

  /* ---------------- summary / export ---------------- */
  let sumT = null; function openSummarySoon() { clearTimeout(sumT); sumT = setTimeout(openSummary, 800); }
  let SUM = null;
  async function openSummary() {
    try { H = await rpc('bb_host', { p_code: cur }); } catch (e) { noAccess(e); return; }
    const evs = await PBB.rpc(sb, 'bb_events', { p_code: cur, p_key: H.view_key });
    const { data: audit } = await sb.from('bb_audit').select('actor,action,detail,at').eq('match_id', (await sb.from('bb_matches').select('id').eq('code', cur).single()).data.id).order('at', { ascending: false }).limit(200);
    SUM = { H, evs, audit: audit || [] };
    if (!conn || conn._code !== cur) { conn && conn.close(); conn = PBB.connect({ code: cur, key: H.view_key, signedIn: true, onSnap: paintLive, onStatus: liveStatus }); conn._code = cur; }
    const d = H.derived, c = H.config;
    $('smTitle').textContent = H.title || 'Match';
    $('smKicker').textContent = (H.status === 'final' ? 'FINAL RESULT' : H.status === 'live' ? 'LIVE · IN PROGRESS' : 'MATCH SUMMARY') + ' · ' + cur;
    $('smMeta').textContent = [H.venue, (H.starts_at || H.created_at) ? new Date(H.starts_at || H.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''].filter(Boolean).join(' · ');
    const pers = Object.keys(d.period_scores || {}).map(Number).sort((a, b) => a - b);
    const win = H.status === 'final' ? (d.score.home > d.score.away ? 'home' : d.score.away > d.score.home ? 'away' : '') : '';
    const tm = (t) => '<div class="sh-team ' + t + (win === t ? ' win' : '') + '" style="--c:' + H[t].color + '">'
      + (H[t].logo ? '<img src="' + H[t].logo + '" alt="">' : '<span class="sh-dot">' + E((H[t].short || H[t].name || '?').slice(0, 3)) + '</span>')
      + '<span class="sh-nm"><b>' + E(H[t].name) + '</b><small>' + (t === 'home' ? 'HOME' : 'AWAY') + ' · ' + E(H[t].short || '') + (win === t ? ' · WINNER' : '') + '</small></span><span class="sh-pts">' + d.score[t] + '</span></div>';
    const line = '<table class="ls"><thead><tr><th></th>' + pers.map((p) => '<th>' + PBB.periodLabel(p, c.periods) + '</th>').join('') + '<th>T</th></tr></thead><tbody>'
      + ['home', 'away'].map((t) => '<tr><td><i style="background:' + H[t].color + '"></i>' + E(H[t].short) + '</td>' + pers.map((p) => '<td>' + d.period_scores[p][t] + '</td>').join('') + '<td><b>' + d.score[t] + '</b></td></tr>').join('') + '</tbody></table>';
    $('smHead').innerHTML = '<div class="sh-board">' + tm('home') + '<div class="sh-mid"><span class="st ' + H.status + '">' + H.status.toUpperCase() + '</span>' + (pers.length ? line : '<span class="tiny">No points yet</span>') + '</div>' + tm('away') + '</div>';
    const cols = [['pts', 'PTS'], ['m1', '1PM'], ['m2', '2PM'], ['m3', '3PM'], ['fta', 'FTA'], ['fga', 'FGA'], ['reb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK'], ['tov', 'TOV'], ['pf', 'PF'], ['tf', 'TF'], ['uf', 'UF'], ['df', 'DF']];
    $('boxSeg').children[0].textContent = H.home.name; $('boxSeg').children[1].textContent = H.away.name;
    $('smBox').innerHTML = ['home', 'away'].map((t) => {
      const pl = H.players.filter((p) => p.team === t).sort((a, b) => Number(a.number) - Number(b.number));
      const tot = {}; cols.forEach(([k]) => { tot[k] = pl.reduce((s2, p) => s2 + ((d.players[p.id] || {})[k] || 0), 0); });
      const top = Math.max(0, ...pl.map((p) => (d.players[p.id] || {}).pts || 0));
      return '<div class="bx' + (t === boxTeam ? '' : ' bx-off') + '" data-team="' + t + '" style="--c:' + H[t].color + '"><div class="bx-name">' + E(H[t].name) + '</div><div class="tbl-wrap"><table class="box-score bx-t"><thead><tr><th>#</th><th class="pl">Player</th>' + cols.map(([k, l]) => '<th' + (k === 'pts' ? ' class="pt"' : '') + '>' + l + '</th>').join('') + '</tr></thead><tbody>'
        + pl.map((p) => { const st = d.players[p.id] || {}; return '<tr' + (p.active ? '' : ' class="ina"') + '><td class="no">' + E(p.number) + '</td><td class="pl">' + E(PBB.playerName(p)) + (st.out ? ' <span class="tag-out">' + (st.dq ? 'DQ' : 'FO') + '</span>' : '') + (top && st.pts === top ? ' <span class="tag-top">TOP</span>' : '') + '</td>' + cols.map(([k]) => '<td class="' + (k === 'pts' ? 'pt' : '') + ((st[k] || 0) ? '' : ' z') + '">' + (st[k] || 0) + '</td>').join('') + '</tr>'; }).join('')
        + '</tbody><tfoot><tr><td></td><td class="pl">Team totals' + (d.unassigned[t] ? ' <span class="tiny">(+' + d.unassigned[t] + ' unassigned)</span>' : '') + '</td>' + cols.map(([k]) => '<td class="' + (k === 'pts' ? 'pt' : '') + '">' + (k === 'pts' ? tot[k] + d.unassigned[t] : tot[k]) + '</td>').join('') + '</tr></tfoot></table></div></div>';
    }).join('');
    const P = (id) => H.players.find((p) => p.id === id);
    const icon = { score: '●', foul: '!', timeout: 'T', period: '◷', final: '⚑', reopen: '↺', undo: '↶', redo: '↷', edit: '✎', clock: '⏱', stat: '+', sub: '⇄', lineup: '☰', possession: '→', overlay: '▣', broadcast: '🎨', lock: '🔒', score_adj: '±' };
    $('smEv').innerHTML = evs.map((e) => { const p = P(e.player_id), T = e.team ? H[e.team] : null, dd = e.data || {};
      const txt = { score: (p ? '#' + p.number + ' ' + PBB.playerName(p, true) : (T ? T.short + ' team' : '')) + ' +' + e.value, foul: (p ? '#' + p.number + ' ' + PBB.playerName(p, true) : (T ? T.short : '')) + ' · ' + PBB.FOUL_SHORT[dd.kind || 'P'] + ' foul', timeout: 'Timeout ' + (T ? T.name : ''), period: 'Period → ' + PBB.periodLabel(dd.to, c.periods), score_adj: (T ? T.short : '') + ' manual ' + e.value, undo: 'Undo ' + (dd.what || ''), redo: 'Redo ' + (dd.what || ''), edit: 'Edited ' + (dd.what || ''), clock: 'Clock ' + (dd.op || ''), final: 'FINAL', reopen: 'Reopened', stat: (p ? '#' + p.number : '') + ' ' + (e.value > 0 ? '+' : '−') + String(dd.key || '').toUpperCase(), sub: (T ? T.short : '') + ' substitution', lineup: (T ? T.short : '') + ' lineup', possession: 'Possession ' + (T ? T.short : '—'), overlay: 'Overlay ' + (dd.op || '') + (dd.text ? ' · ' + dd.text : ''), broadcast: 'Broadcast settings', lock: 'Settings lock' }[e.type] || e.type;
      const sys = !T && e.type !== 'final' && e.type !== 'period';
      return '<div class="pe' + (e.undone ? ' undone' : '') + (sys ? ' sys' : '') + ' k-' + e.type + '" style="--c:' + (T ? T.color : '#5b6684') + '"><span class="pe-per">' + PBB.periodLabel(e.period, c.periods) + '</span><span class="pe-ic">' + (icon[e.type] || '•') + '</span><span class="pe-tx"><b>' + E(txt) + '</b><small>' + E(e.actor) + ' · ' + E(e.role) + (e.edited ? ' · edited' : '') + (e.undone ? ' · undone' : '') + '</small></span><span class="pe-t">' + new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</span></div>'; }).join('') || '<div class="empty-s">No plays yet.</div>';
    $('smAudit').innerHTML = SUM.audit.map((a) => '<div class="au"><span class="au-t">' + new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</span><b>' + E(a.actor) + '</b><span class="au-a">' + E(a.action) + '</span></div>').join('') || '<div class="empty-s">No audit entries.</div>';
  }
  let boxTeam = 'home';
  $('boxSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; boxTeam = b.dataset.t; [...$('boxSeg').children].forEach((x) => x.classList.toggle('on', x === b)); document.querySelectorAll('#smBox .bx').forEach((x) => x.classList.toggle('bx-off', x.dataset.team !== boxTeam)); };
  $('sideSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; [...$('sideSeg').children].forEach((x) => x.classList.toggle('on', x === b)); $('smEv').classList.toggle('hidden', b.dataset.s !== 'ev'); $('smAudit').classList.toggle('hidden', b.dataset.s !== 'au'); };
  $('xPrint').onclick = () => window.print();
  $('xCsv').onclick = () => {
    if (!SUM) return; const H2 = SUM.H, d = H2.derived;
    const rows = [['Match', H2.code, H2.title, H2.venue, new Date(H2.starts_at || H2.created_at).toISOString(), H2.status], ['Final', H2.home.name, d.score.home, H2.away.name, d.score.away], [],
      ['Team', 'Number', 'Player', 'PTS', '1PM', '2PM', '3PM', 'PF', 'TF', 'UF', 'DF', 'REB', 'AST', 'STL', 'BLK', 'TOV', 'FTA', 'FGA']];
    H2.players.forEach((p) => { const s = d.players[p.id] || {}; rows.push([H2[p.team].name, p.number, PBB.playerName(p), s.pts, s.m1, s.m2, s.m3, s.pf, s.tf, s.uf, s.df, s.reb, s.ast, s.stl, s.blk, s.tov, s.fta, s.fga]); });
    rows.push([], ['Seq', 'Time', 'Period', 'Type', 'Team', 'Player', 'Value', 'Detail', 'Actor', 'Undone']);
    SUM.evs.slice().reverse().forEach((e) => { const p = H2.players.find((x) => x.id === e.player_id); rows.push([e.seq, e.at, PBB.periodLabel(e.period, H2.config.periods), e.type, e.team || '', p ? '#' + p.number + ' ' + PBB.playerName(p) : '', e.value, JSON.stringify(e.data || {}), e.actor, e.undone ? 'yes' : '']); });
    const csv = rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = 'basketball-' + H2.code + '.csv'; a.click();
  };
  $('xImg').onclick = async () => {
    if (!SUM) return; const H2 = SUM.H, d = H2.derived;
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1080; const g = cv.getContext('2d');
    await document.fonts.ready;
    const bg = g.createLinearGradient(0, 0, 0, 1080); bg.addColorStop(0, '#0d1428'); bg.addColorStop(1, '#03050c'); g.fillStyle = bg; g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = '#39ff14'; g.font = '800 34px Poppins'; g.textAlign = 'center'; g.fillText(H2.status === 'final' ? 'FINAL' : 'LIVE SCORE', 540, 150);
    g.fillStyle = '#aab3cc'; g.font = '600 30px Poppins'; g.fillText((H2.title || 'Basketball').toUpperCase(), 540, 205);
    const side = (t, x) => { const T = H2[t]; g.fillStyle = T.color; g.fillRect(x - 160, 290, 320, 10); g.font = '800 46px Poppins'; g.fillText(T.short, x, 380); g.fillStyle = '#fff'; g.font = '600 26px Poppins'; g.fillText(T.name.slice(0, 22), x, 425); g.fillStyle = T.color; g.font = '900 190px Orbitron'; g.fillText(String(d.score[t]), x, 640); };
    side('home', 290); side('away', 790);
    g.fillStyle = '#6c7695'; g.font = '700 60px Poppins'; g.fillText('—', 540, 580);
    const top = H2.players.map((p) => ({ p, s: d.players[p.id] || {} })).sort((a, b) => (b.s.pts || 0) - (a.s.pts || 0)).slice(0, 3).filter((x) => x.s.pts);
    g.font = '600 28px Poppins'; g.fillStyle = '#aab3cc'; if (top.length) g.fillText('TOP SCORERS', 540, 760);
    top.forEach((x, i) => { g.fillStyle = H2[x.p.team].color; g.font = '700 32px Poppins'; g.fillText('#' + x.p.number + ' ' + PBB.playerName(x.p) + ' · ' + x.s.pts + ' PTS', 540, 815 + i * 50); });
    g.fillStyle = '#6c7695'; g.font = '600 24px Poppins'; g.fillText((H2.venue ? H2.venue + ' · ' : '') + new Date(H2.starts_at || H2.created_at).toLocaleDateString() + ' · dinkykong.pro', 540, 1030);
    cv.toBlob(async (blob) => {
      const file = new File([blob], 'result-' + H2.code + '.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Final score' }); return; } catch (e) {} }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    }, 'image/png');
  };

  PBCommon.registerSW && PBCommon.registerSW();
  addEventListener('hashchange', () => { if (PBAuth.user) route(); });
  boot();
})();
