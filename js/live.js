/* DinkyKong LIVE: 2–6 courts on one screen, each with its own code/QR and referee remote,
 * plus an OBS lower third fed live through the internet relay. Unlocked by the organizer's LIVE pass. */
(function () {
  const { seg, store, ICON, keepAwake, registerSW, loadScript, LIBS, esc } = PBCommon;
  const E = PBEngine;
  const $ = (id) => document.getElementById(id);
  registerSW();

  const AUTH = PBAuth.enabled;
  const KEY = 'aopb.live';
  const saved = store.get(KEY, null) || {};
  const cfg = {
    n: Math.min(6, Math.max(2, saved.n || 4)),
    obsKey: saved.obsKey || rand(12),
    actCode: PBLink.makeCode(),   // new activation code every time the LIVE page opens
    courts: Array.isArray(saved.courts) ? saved.courts : []
  };
  // Lower third branding (organizer's own logo + caption). Kept separately; images are resized before saving.
  let brand = store.get('aopb.liveBrand', null) || { id: 'dk', logo: null, caption: '' };
  // The LIVE pass is never restored after a refresh: the screen always opens locked on the activation QR,
  // so nobody can reuse the organizer's pass by reloading. (Trial codes can be re-entered on the same screen.)
  let license = null;   // { until, email, name, trial }
 
  const liveOK = () => !AUTH || (license && new Date(license.until).getTime() > Date.now());

  function rand(n) { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; crypto.getRandomValues(new Uint8Array(n)).forEach((b) => { s += a[b % a.length]; }); return s; }
  function save() { store.set(KEY, { n: cfg.n, obsKey: cfg.obsKey, actCode: cfg.actCode, courts: courts.map((c) => ({ code: c.code, state: c.state })) }); }
  const remoteUrl = (code, extra) => new URL('remote.html?c=' + code + (extra || ''), location.href).href;

  /* ---------- Courts ---------- */
  const courts = [];   // { code, state, link, remotes, el }
  function makeCourt(i) {
    const prev = cfg.courts[i] || {};
    const c = { i, code: prev.code || PBLink.makeCode(), state: E.ensure(prev.state && prev.state.v === 1 ? prev.state : E.newMatch()), link: null, remotes: 0, el: null, prev: prev.state ? prev.state.score.slice() : [0, 0] };
    if (c.state.matchOver && !prev.keepFinal) { /* keep the final on screen until a new match is started from the remote */ }
    return c;
  }
  function startCourtLink(c) {
    if (typeof PBLink === 'undefined') return;
    c.link = PBLink.host({
      code: c.code,
      getState: () => Object.assign(E.publicState(c.state), { liveCourt: true, court: c.i + 1 }),
      onAction: (action, reply) => {
        if (!liveOK()) { reply({ t: 'denied', reason: 'LIVE_ENDED' }); return; }
        if (action && action.a === 'rally' && action.side != null) action = { a: 'rally', team: c.state.swapped ? 1 - action.side : action.side };
        c.state = E.apply(c.state, action);
        save(); renderCourt(c); pushObs();
        c.link.broadcast(Object.assign(E.publicState(c.state), { liveCourt: true, court: c.i + 1 }));
      },
      onMessage: (msg, reply) => {
        if (msg.t === 'auth' || msg.t === 'recheck') {   // referees don't sign in: the organizer's LIVE pass covers this court
          if (liveOK()) reply({ t: 'authok', free: true, live: true, silent: true });
          else reply({ t: 'denied', reason: 'LIVE_ENDED' });
        }
        // 'release' (referee left): the court keeps its score and code for the next referee
      },
      onStatus: (st) => {
        if (st.state === 'newcode') { c.code = PBLink.makeCode(); save(); c.link.destroy(); startCourtLink(c); renderAllQr(); return; }
        c.remotes = st.remotes || 0;
        if (st.joined) toast('COURT ' + (c.i + 1) + ' · REFEREE CONNECTED');
        renderCourt(c); pushObs();
      }
    });
  }

  function courtTile(c) {
    const el = document.createElement('article');
    el.className = 'lv-court';
    el.innerHTML =
      '<div class="lvc-head"><b>COURT ' + (c.i + 1) + '</b><span class="lvc-meta"></span><button class="lvc-ref" title="Show this court\'s QR code"><span class="dot"></span><span class="lvc-ref-txt"></span></button></div>' +
      '<div class="lvc-body">' +
      '<div class="lvc-team" data-t="0"><div class="lvc-name"></div><div class="lvc-score"></div><div class="lvc-foot"><span class="lvc-srv"></span><span class="lvc-pips"></span></div></div>' +
      '<div class="lvc-mid"><div class="lvc-call"></div></div>' +
      '<div class="lvc-team" data-t="1"><div class="lvc-name"></div><div class="lvc-score"></div><div class="lvc-foot"><span class="lvc-srv"></span><span class="lvc-pips"></span></div></div>' +
      '</div>' +
      '<div class="lvc-scan"><div class="qr-box lvc-qr"></div><div><div class="eyebrow">Referee · scan to score</div><div class="code lvc-code"></div></div></div>' +
      '<div class="lvc-final hidden"><span class="eyebrow">Match winner</span><b class="lvc-winner"></b><small class="lvc-games"></small></div>';
    el.querySelector('.lvc-ref').onclick = () => showQrs(c.i);
    c.el = el;
    return el;
  }

  function renderCourt(c) {
    const el = c.el; if (!el) return;
    const st = c.state, s = st.settings;
    const left = st.swapped ? 1 : 0;
    const pub = E.publicState(st);
    el.querySelector('.lvc-meta').textContent = (s.bestOf > 1 ? 'GAME ' + st.gameNo + ' · BEST OF ' + s.bestOf : 'TO ' + s.target) + ' · ' + (s.scoring === 'rally' ? 'RALLY' : (s.mode === 'doubles' ? 'DOUBLES' : 'SINGLES'));
    el.querySelectorAll('.lvc-team').forEach((tEl, side) => {
      const t = side === 0 ? left : 1 - left;
      tEl.style.setProperty('--c', s.colors[t]);
      tEl.classList.toggle('serving', st.serving === t && !st.matchOver && !st.playForServe);
      tEl.querySelector('.lvc-name').textContent = s.names[t];
      const sc = tEl.querySelector('.lvc-score');
      if (sc.dataset.v !== String(st.score[t])) {
        const up = sc.dataset.v != null && st.score[t] > Number(sc.dataset.v);
        sc.dataset.v = st.score[t]; sc.innerHTML = seg(st.score[t], 2);
        if (up) { sc.classList.remove('bump'); void sc.offsetWidth; sc.classList.add('bump'); }
      }
      tEl.querySelector('.lvc-srv').innerHTML = st.serving === t && !st.matchOver && !st.playForServe ? ICON.ball + '<span>' + esc(pub.hasPlayers ? pub.serverName : (s.mode === 'doubles' && s.scoring === 'sideout' ? (st.serverNum === 1 ? '1st server' : '2nd server') : 'Serving')) + '</span>' : '';
      tEl.querySelector('.lvc-pips').innerHTML = s.bestOf > 1 ? Array.from({ length: Math.ceil(s.bestOf / 2) }, (_, i) => '<i class="' + (i < st.games[t] ? 'on' : '') + '"></i>').join('') : '';
    });
    el.querySelector('.lvc-call').innerHTML = st.matchOver ? '' : st.playForServe ? '<span class="pfs-call">PLAY FOR SERVE</span>' : seg(E.callout(st));
    const ref = c.remotes > 0;
    el.classList.toggle('has-ref', ref);
    el.querySelector('.lvc-ref').classList.toggle('ok', ref);
    el.querySelector('.lvc-ref-txt').textContent = ref ? (c.remotes === 1 ? 'Referee' : c.remotes + ' remotes') : 'Code ' + c.code;
    el.querySelector('.lvc-code').textContent = c.code;
    const fin = el.querySelector('.lvc-final');
    fin.classList.toggle('hidden', !st.matchOver);
    if (st.matchOver) {
      el.querySelector('.lvc-winner').textContent = s.names[st.winner]; el.querySelector('.lvc-winner').style.color = s.colors[st.winner];
      el.querySelector('.lvc-games').textContent = st.gameLog.map((g) => g.a + '–' + g.b).join('  ·  ');
    }
  }

  function drawQr(box, url, size) {
    if (typeof qrcode === 'undefined') { box.innerHTML = '<div class="qr-off">QR offline<br>use the code</div>'; return; }
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    box.innerHTML = '<img alt="QR code" src="' + qr.createDataURL(size || 8, 0) + '">';
  }
  function renderAllQr() {
    courts.forEach((c) => { if (c.el) { drawQr(c.el.querySelector('.lvc-qr'), remoteUrl(c.code, '&live=1'), 6); c.el.querySelector('.lvc-code').textContent = c.code; } });
    drawQr($('actQr'), remoteUrl(cfg.actCode, '&act=1'), 10);
    $('actCode').textContent = cfg.actCode;
  }

  function layout() {
    const grid = $('grid');
    // keep existing courts, add/remove to match n
    while (courts.length > cfg.n) { const c = courts.pop(); if (c.link) c.link.destroy(); if (c.el) c.el.remove(); }
    while (courts.length < cfg.n) { const c = makeCourt(courts.length); courts.push(c); grid.appendChild(courtTile(c)); if (linkReady) startCourtLink(c); }
    grid.dataset.n = cfg.n;
    courts.forEach(renderCourt); renderAllQr(); save(); pushObs();
    document.querySelectorAll('#nPick button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === cfg.n));
  }
  $('nPick').querySelectorAll('button').forEach((b) => b.onclick = () => {
    const n = Number(b.dataset.n); if (n === cfg.n) return;
    const losing = courts.slice(n).filter((c) => c.remotes > 0 || c.state.score[0] + c.state.score[1] > 0);
    if (losing.length && !confirm('Remove ' + losing.map((c) => 'Court ' + (c.i + 1)).join(', ') + '? Their referees will be disconnected and the score cleared.')) return;
    courts.slice(n).forEach((c) => { cfg.courts[c.i] = null; });
    cfg.n = n; cfg.courts = cfg.courts.slice(0, n); layout();
  });

  /* ---------- Organizer activation (LIVE pass) ---------- */
  let actLink = null;
  function setActMsg(t, kind) { const el = $('actStatus'); el.textContent = t || ''; el.className = 'pair-status' + (kind ? ' ' + kind : ''); }
  function startActLink() {
    actLink = PBLink.host({
      code: cfg.actCode,
      getState: () => Object.assign(E.publicState(E.newMatch({ names: ['LIVE', 'ACTIVATION'] })), { liveAct: true }),
      onAction: (a, reply) => reply({ t: 'denied', reason: 'ACTIVATION_ONLY' }),
      onMessage: async (msg, reply) => {
        if (msg.t === 'release') { exitLive(); return; }   // organizer tapped "Exit LIVE" on their phone
        if (msg.t !== 'auth') return;
        if (!AUTH) { reply({ t: 'authok', free: true, live: true }); return; }
        setActMsg('Checking LIVE pass…');
        let res; try { res = await PBAuth.verifyToken(msg.token, { device: msg.device, live: true }); } catch (e) { res = { ok: false, reason: 'ERROR' }; }
        if (res.ok) {
          license = { until: res.until, email: res.email || '', name: res.name || '' };
          reply({ t: 'authok', live: true, until: res.until, name: res.name });
          setActMsg(''); renderLicense(); toast('LIVE ON · ' + String(res.name || res.email || '').split(' ')[0].toUpperCase());
          pushObs();
        } else {
          reply({ t: 'denied', reason: res.reason, email: res.email, live: true });
          const who = res.email || 'this account';
          setActMsg(res.reason === 'NO_LIVE_PASS' ? 'No LIVE pass on ' + who + ' yet — pick a LIVE pass on your phone (from PHP 20 / hour)'
            : res.reason === 'OTHER_DEVICE' ? who + ' is locked to another phone' : res.reason === 'NOT_SIGNED_IN' ? 'Phone connected · waiting for Google sign-in' : 'Could not check the pass — try again', res.reason === 'NOT_SIGNED_IN' ? '' : 'bad');
        }
      },
      onStatus: (st) => {
        if (st.state === 'newcode') { cfg.actCode = PBLink.makeCode(); save(); actLink.destroy(); startActLink(); renderAllQr(); return; }
        if (st.joined && !liveOK()) setActMsg('Phone connected · sign in with Google on your phone');
      }
    });
  }
  /* ---------- Exit LIVE: lock the screen and get it ready for the next organizer ---------- */
  function exitLive() {
    license = null;
    // referees are disconnected and every court gets a new code + a fresh match
    courts.forEach((c) => {
      try { c.link && c.link.broadcastMsg({ t: 'reset' }); } catch (e) {}
      const old = c.link; setTimeout(() => { try { old && old.destroy(); } catch (e) {} }, 800);
      c.link = null; c.code = PBLink.makeCode(); c.state = E.newMatch(); c.remotes = 0;
    });
    setTimeout(() => { courts.forEach((c) => { if (!c.link && linkReady) startCourtLink(c); renderCourt(c); }); renderAllQr(); }, 900);
    brand = { id: rand(8), logo: null, caption: '' }; store.del('aopb.liveBrand'); renderBrand();
    $('stripToggle').checked = false; applyStrip();
    // new activation code so the previous organizer's phone can't switch it back on
    const oldAct = actLink; cfg.actCode = PBLink.makeCode(); actLink = null;
    setTimeout(() => { try { oldAct && oldAct.destroy(); } catch (e) {} startActLink(); renderAllQr(); }, 800);
    ['qrOverlay', 'obsOverlay'].forEach((id) => $(id).classList.add('hidden'));
    $('trialIn').value = ''; $('trialErr').textContent = '';
    save(); setActMsg('LIVE was closed by the organizer · ready for the next organizer'); renderLicense(); pushObs();
    toast('LIVE CLOSED');
  }

  /* ---------- Trial code from the owner: 1 hour of LIVE, no sign-in ---------- */
  let screenId = store.get('aopb.screenId', null);
  if (!screenId) { screenId = 'scr-' + rand(16); store.set('aopb.screenId', screenId); }
  $('trialIn').addEventListener('input', (e) => { e.target.value = PBCommon.fmtTrial(e.target.value) || e.target.value.toUpperCase(); });
  $('trialIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('trialBtn').click(); e.stopPropagation(); });
  $('trialBtn').onclick = async () => {
    const code = $('trialIn').value.replace(/[^A-Za-z0-9]/g, '');
    const err = $('trialErr'); err.className = 'trial-err';
    if (code.length < 10) { err.textContent = 'Trial codes look like DK-XXXX-XXXX.'; return; }
    $('trialBtn').disabled = true; err.textContent = 'Checking code…';
    let res; try { res = await PBAuth.redeemLiveCode(code, screenId); } catch (e) { res = { ok: false, reason: 'ERROR' }; }
    $('trialBtn').disabled = false;
    if (res.ok) {
      license = { until: res.until, email: 'Trial code', name: 'Trial', trial: true };
      err.className = 'trial-err ok'; err.textContent = ''; $('trialIn').value = '';
      renderLicense(); pushObs(); toast('LIVE TRIAL · 1 HOUR');
    } else {
      err.textContent = res.reason === 'USED_CODE' ? 'This code was already used.' : res.reason === 'EXPIRED_CODE' ? 'This code has expired (codes must be used within 7 days).'
        : res.reason === 'BAD_CODE' ? 'That code isn’t valid. Check it and try again.' : 'Could not check the code — check the internet connection.';
    }
  };

  function hhmm(d) { const t = new Date(d); const far = t - Date.now() > 20 * 3600e3; return (far ? t.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '') + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function renderLicense() {
    const ok = liveOK();
    $('actOverlay').classList.toggle('hidden', ok);
    const chip = $('livePass');
    chip.classList.toggle('hidden', !AUTH || !ok); chip.classList.toggle('ok', ok);
    if (ok && AUTH) $('livePassTxt').textContent = (license.trial ? 'TRIAL until ' : 'LIVE until ') + hhmm(license.until);
    $('live').classList.toggle('locked', !ok);
  }
  setInterval(() => {
    if (AUTH && license && !liveOK()) {
      const wasTrial = !!license.trial; license = null; store.del('aopb.liveLicense');
      courts.forEach((c) => c.link && c.link.broadcastMsg({ t: 'reauth' }));
      setActMsg(wasTrial ? 'Trial hour ended · scan to activate with a LIVE pass' : 'LIVE pass ended · scan to renew', 'bad'); toast('LIVE PASS ENDED');
    }
    renderLicense();
  }, 15000);

  /* ---------- OBS feed (internet relay) + on-screen strip ---------- */
  let obs = null, obsTimer = 0;
  const obsUrl = () => new URL('obs.html?k=' + cfg.obsKey, location.href).href;
  function summaries() { return courts.map((c) => PBStrip.summary(c.state, c.i, c.remotes)); }
  function pushObs() {
    const list = summaries();
    const opts = { logo: brand.logo, caption: brand.caption };
    PBStrip.render($('strip'), list, opts); PBStrip.render($('obsPreview'), list, opts);
    clearTimeout(obsTimer);
    obsTimer = setTimeout(() => { if (obs) obs.send({ t: 'obs', on: liveOK(), courts: liveOK() ? list : [], brand: brand.id, caption: brand.caption, at: Date.now() }); }, 120);
  }
  function startObs() {
    if (obs) obs.close();
    if (!PBAuth.relay) return;
    PBAuth.relay('dk-obs-' + cfg.obsKey, (m) => {
      if (m && m.t === 'sync') pushObs();
      if (m && m.t === 'brand?' && obs) obs.send({ t: 'brand', id: brand.id, logo: brand.logo, caption: brand.caption });   // logo is sent only when OBS asks
    }).then((r) => { obs = r; pushObs(); }).catch(() => {});
  }
  setInterval(pushObs, 5000);   // OBS sources that load late still catch up within seconds
  $('obsUrl').value = obsUrl();
  $('obsBtn').onclick = () => { $('obsUrl').value = obsUrl(); pushObs(); $('obsOverlay').classList.remove('hidden'); };
  $('obsClose').onclick = () => $('obsOverlay').classList.add('hidden');
  $('obsCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(obsUrl()); toast('OBS LINK COPIED'); } catch (e) { $('obsUrl').select(); document.execCommand && document.execCommand('copy'); toast('OBS LINK COPIED'); }
  };
  $('obsNew').onclick = () => {
    if (!confirm('Make a new OBS link? The old link stops updating, so you will need to paste the new one into OBS.')) return;
    cfg.obsKey = rand(12); save(); $('obsUrl').value = obsUrl(); startObs(); toast('NEW OBS LINK');
  };
  const stripOn = store.get('aopb.liveStrip', false);
  $('stripToggle').checked = !!stripOn;
  function applyStrip() { const on = $('stripToggle').checked; $('stripWrap').classList.toggle('hidden', !on); $('live').classList.toggle('strip-on', on); store.set('aopb.liveStrip', on); }
  $('stripToggle').onchange = applyStrip; applyStrip();

  /* ---------- Branding: upload / reset the lower-third logo ---------- */
  function renderBrand() { $('logoPrev').src = brand.logo || 'icons/dinkykong-logo.png'; $('captionIn').value = brand.caption || ''; }
  function setBrand(b) {
    brand = Object.assign({}, brand, b, { id: rand(8) });
    try { store.set('aopb.liveBrand', brand); } catch (e) {}
    renderBrand(); pushObs();
    if (obs) obs.send({ t: 'brand', id: brand.id, logo: brand.logo, caption: brand.caption });
  }
  function resizeLogo(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 320, k = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
        const w = Math.max(1, Math.round((img.naturalWidth || max) * k)), h = Math.max(1, Math.round((img.naturalHeight || max) * k));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
        let data = cv.toDataURL('image/webp', 0.9); if (!data.startsWith('data:image/webp')) data = cv.toDataURL('image/png');
        resolve(data);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  $('logoFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('IMAGE TOO LARGE (MAX 8 MB)'); return; }
    try { setBrand({ logo: await resizeLogo(f) }); toast('LOGO UPDATED'); } catch (err) { toast('COULD NOT READ THAT IMAGE'); }
  };
  $('logoReset').onclick = () => { setBrand({ logo: null }); toast('DINKYKONG LOGO'); };
  let capT; $('captionIn').oninput = () => { clearTimeout(capT); capT = setTimeout(() => setBrand({ caption: $('captionIn').value.trim().toUpperCase() }), 400); };
  renderBrand();

  /* ---------- QR overlay ---------- */
  function showQrs(focus) {
    $('qrGrid').innerHTML = courts.map((c) => '<div class="lv-qr-card' + (c.i === focus ? ' focus' : '') + '"><b>COURT ' + (c.i + 1) + '</b><div class="qr-box" data-i="' + c.i + '"></div><div class="code">' + c.code + '</div><small>' + (c.remotes ? '● Referee connected' : 'Waiting for referee') + '</small></div>').join('');
    $('qrGrid').querySelectorAll('.qr-box').forEach((b) => drawQr(b, remoteUrl(courts[Number(b.dataset.i)].code, '&live=1'), 8));
    $('qrOverlay').classList.remove('hidden');
  }
  $('qrBtn').onclick = () => showQrs(-1);
  $('qrClose').onclick = () => $('qrOverlay').classList.add('hidden');

  /* ---------- UI bits ---------- */
  let toastT;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1800); }
  $('fsBtn').innerHTML = ICON.full;
  $('fsBtn').onclick = () => { const d = document.documentElement; if (!document.fullscreenElement) (d.requestFullscreen || function () {}).call(d); else document.exitFullscreen(); keepAwake(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ['qrOverlay', 'obsOverlay'].forEach((id) => $(id).classList.add('hidden')); });

  // Presence: count this LIVE screen in "online now" / "courts scoring"
  let liveHandle = null;
  PBAuth.live('L-' + rand(8), { r: 'board', live: false }, () => {}).then((h) => { liveHandle = h; }).catch(() => {});
  setInterval(() => { if (liveHandle) liveHandle.update({ r: 'board', live: liveOK() && courts.some((c) => c.remotes > 0) }); }, 10000);

  /* ---------- Boot ---------- */
  let linkReady = false;
  try { sessionStorage.setItem('aopb.tabRole', 'display'); localStorage.setItem('aopb.role', 'display'); } catch (e) {}
  layout(); renderLicense(); keepAwake();
  Promise.allSettled([loadScript(LIBS.qr), loadScript(LIBS.peer)]).then(() => {
    linkReady = true;
    courts.forEach((c) => { if (!c.link) startCourtLink(c); });
    startActLink(); startObs(); renderAllQr();
  });
})();
