/* DinkyKong LIVE: 1–6 courts on one screen, each with its own code/QR and referee remote,
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
    n: Math.min(6, Math.max(1, saved.n || 4)),
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
  function save() { store.set(KEY, { n: cfg.n, obsKey: cfg.obsKey, actCode: cfg.actCode, courts: courts.map((c) => ({ code: c.code, state: c.state, tm: c.tm || null })) }); }
  const remoteUrl = (code, extra) => new URL('remote.html?c=' + code + (extra || ''), location.href).href;

  /* ---------- Courts ---------- */
  const courts = [];   // { code, state, link, remotes, el }
  function makeCourt(i) {
    const prev = cfg.courts[i] || {};
    const c = { i, code: prev.code || PBLink.makeCode(), state: E.ensure(prev.state && prev.state.v === 1 ? prev.state : E.newMatch()), tm: prev.tm || null, link: null, remotes: 0, el: null, prev: prev.state ? prev.state.score.slice() : [0, 0] };
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
        if (action && action.a === 'new' && tour) { tourNext(c); return; }   // tournament court: "New match" loads the next scheduled match
        c.state = E.apply(c.state, action);
        save(); renderCourt(c); pushObs(); tourWatch(c);
        c.link.broadcast(Object.assign(E.publicState(c.state), { liveCourt: true, court: c.i + 1 }));
      },
      onMessage: (msg, reply) => {
        if (msg.t === 'rtt') { reply(msg); return; }
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
      '<div class="lvc-flash"><span class="lvc-flash-lbl"></span><div class="lvc-flash-call"></div></div>' +
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
    const tm = tour && c.tm ? tour.matches.find((m) => m.id === c.tm) : null;
    el.classList.toggle('tour', !!tour);
    el.querySelector('.lvc-meta').textContent = (tm ? tm.label + ' · ' : tour && !st.matchOver && st.score[0] + st.score[1] === 0 && !c.tm ? 'WAITING FOR NEXT MATCH · ' : '') + (s.bestOf > 1 ? 'GAME ' + st.gameNo + ' · BEST OF ' + s.bestOf : 'TO ' + s.target) + ' · ' + (s.scoring === 'rally' ? 'RALLY' : (s.mode === 'doubles' ? 'DOUBLES' : 'SINGLES'));
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
    el.querySelector('.lvc-call').innerHTML = st.playForServe && !st.matchOver ? '<span class="pfs-call">PLAY FOR SERVE</span>' : '';
    el.classList.toggle('pfs', !!st.playForServe && !st.matchOver);
    // 3-number call pops up big over a blurred court for 3 s after every score / serve change (like the main scoreboard)
    const ev = st.lastEvent;
    if (c.evT === undefined) c.evT = ev ? ev.t : 0;
    else if (ev && ev.t !== c.evT) {
      c.evT = ev.t;
      if (c.i === 0 && voiceOn()) liveAnnounce(st, ev);
      const show = { point: 1, sideout: 1, second: 1, undo: 1, server: 1, pfs: 1, newgame: 1 }[ev.type] && !st.gameOver && !st.matchOver && !st.playForServe;
      if (show) {
        const f = el.querySelector('.lvc-flash'), lbl = { sideout: 'SIDE OUT', second: '2ND SERVER', pfs: (s.names[ev.team] || '') + ' SERVES', newgame: 'GAME ' + st.gameNo }[ev.type] || '';
        const lb = f.querySelector('.lvc-flash-lbl'); lb.textContent = lbl; lb.style.color = ev.team != null ? s.colors[ev.team] : ''; lb.classList.toggle('hidden', !lbl);
        f.querySelector('.lvc-flash-call').innerHTML = seg(E.callout(st));
        f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
        clearTimeout(c.flashT); c.flashT = setTimeout(() => f.classList.remove('show'), 3000);
      }
    }
    const ref = c.remotes > 0;
    el.classList.toggle('has-ref', ref);
    el.querySelector('.lvc-ref').classList.toggle('ok', ref);
    el.querySelector('.lvc-ref-txt').textContent = ref ? (c.remotes === 1 ? 'Referee' : c.remotes + ' remotes') : 'Code ' + c.code;
    el.querySelector('.lvc-code').textContent = c.code;
    const fin = el.querySelector('.lvc-final');
    fin.classList.toggle('hidden', !st.matchOver);
    if (st.matchOver) {
      el.querySelector('.lvc-winner').textContent = s.names[st.winner]; el.querySelector('.lvc-winner').style.color = s.colors[st.winner];
      el.querySelector('.lvc-games').textContent = st.gameLog.map((g) => g.a + '–' + g.b).join('  ·  ') + (tm ? '   ·   NEXT MATCH LOADS SOON' : '');
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
    setCourts(n);
  });
  function setCourts(n) {
    courts.slice(n).forEach((c) => { cfg.courts[c.i] = null; tourRelease(c); });
    cfg.n = n; cfg.courts = cfg.courts.slice(0, n); layout(); if (typeof renderVoice === 'function') renderVoice();
  }

  /* ---------- Organizer activation (LIVE pass) ---------- */
  let actLink = null; const actOk = new Set();   // organizer phones that activated this screen
  function setActMsg(t, kind) { const el = $('actStatus'); el.textContent = t || ''; el.className = 'pair-status' + (kind ? ' ' + kind : ''); }
  function startActLink() {
    actLink = PBLink.host({
      code: cfg.actCode,
      getState: () => Object.assign(E.publicState(E.newMatch({ names: ['LIVE', 'ACTIVATION'] })), { liveAct: true }),
      onAction: (a, reply) => reply({ t: 'denied', reason: 'ACTIVATION_ONLY' }),
      onMessage: async (msg, reply, id) => {
        if (msg.t === 'release') { exitLive(); return; }   // organizer tapped "Exit LIVE" on their phone
        if (msg.t === 'tour?' || msg.t === 'tourStart' || msg.t === 'tourEnd') {   // tournament from the organizer's phone
          if (!liveOK() || (AUTH && !actOk.has(id))) { reply({ t: 'tourErr', reason: 'Activate LIVE first.' }); return; }
          if (msg.t === 'tourStart') {
            if (tour && !msg.replace) { reply({ t: 'tourErr', reason: 'A tournament is already running.' }); return; }
            const bad = startTour(msg.opts || {}); if (bad) { reply({ t: 'tourErr', reason: bad }); return; }
          }
          if (msg.t === 'tourEnd' && tour) endTour();
          reply(tourPhoneState()); return;
        }
        if (msg.t !== 'auth') return;
        if (!AUTH) { reply({ t: 'authok', free: true, live: true }); return; }
        setActMsg('Checking LIVE pass…');
        let res; try { res = await PBAuth.verifyToken(msg.token, { device: msg.device, live: true }); } catch (e) { res = { ok: false, reason: 'ERROR' }; }
        if (res.ok) {
          license = { until: res.until, email: res.email || '', name: res.name || '' };
          actOk.add(id);
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
    license = null; actOk.clear();
    // referees are disconnected and every court gets a new code + a fresh match
    courts.forEach((c) => {
      try { c.link && c.link.broadcastMsg({ t: 'reset' }); } catch (e) {}
      const old = c.link; setTimeout(() => { try { old && old.destroy(); } catch (e) {} }, 800);
      c.link = null; c.code = PBLink.makeCode(); c.state = E.newMatch(); c.remotes = 0;
    });
    setTimeout(() => { courts.forEach((c) => { if (!c.link && linkReady) startCourtLink(c); renderCourt(c); }); renderAllQr(); }, 900);
    brand = { id: rand(8), logo: null, caption: '' }; store.del('aopb.liveBrand'); renderBrand();
    tour = null; saveTour(); courts.forEach((c) => { c.tm = null; clearTimeout(c.tourT); }); $('tourOverlay').classList.add('hidden'); renderTourChip();
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
    const opts = { logo: brand.logo, caption: brand.caption, accent: brand.accent, sponsor: brand.sponsor };
    PBStrip.render($('strip'), list, opts); PBStrip.render($('obsPreview'), list, opts);
    clearTimeout(obsTimer);
    obsTimer = setTimeout(() => { if (obs) obs.send({ t: 'obs', on: liveOK(), courts: liveOK() ? list : [], brand: brand.id, caption: brand.caption, accent: brand.accent || '', sponsor: brand.sponsor || '', tour: liveOK() && obsTour ? tourBoard() : null, at: Date.now() }); }, 120);
  }
  function startObs() {
    if (obs) obs.close();
    if (!PBAuth.relay) return;
    PBAuth.relay('dk-obs-' + cfg.obsKey, (m) => {
      if (m && m.t === 'sync') pushObs();
      if (m && m.t === 'brand?' && obs) obs.send({ t: 'brand', id: brand.id, logo: brand.logo, caption: brand.caption, accent: brand.accent || '', sponsor: brand.sponsor || '' });   // logo is sent only when OBS asks
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
  const ACCENTS = ['', '#5B2A9C', '#0A7BFF', '#00A86B', '#E0262F', '#FF8A00', '#111827'];
  $('accentSw').innerHTML = ACCENTS.map((c) => '<button type="button" data-c="' + c + '" title="' + (c || 'DinkyKong purple') + '" style="--sw:' + (c || 'linear-gradient(160deg,#5b2a9c,#140828)') + '"></button>').join('');
  $('accentSw').querySelectorAll('button').forEach((b) => b.onclick = () => setBrand({ accent: b.dataset.c || null }));
  function renderBrand() {
    $('logoPrev').src = brand.logo || 'icons/dinkykong-logo.png'; $('captionIn').value = brand.caption || ''; $('sponsorIn').value = brand.sponsor || '';
    $('accentSw').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.c || null) === (brand.accent || null)));
  }
  function setBrand(b) {
    brand = Object.assign({}, brand, b, { id: rand(8) });
    try { store.set('aopb.liveBrand', brand); } catch (e) {}
    renderBrand(); pushObs();
    if (obs) obs.send({ t: 'brand', id: brand.id, logo: brand.logo, caption: brand.caption, accent: brand.accent || '', sponsor: brand.sponsor || '' });
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
  let spT; $('sponsorIn').oninput = () => { clearTimeout(spT); spT = setTimeout(() => setBrand({ sponsor: $('sponsorIn').value.trim().toUpperCase() }), 400); };
  ['captionIn', 'sponsorIn'].forEach((id) => $(id).addEventListener('keydown', (e) => e.stopPropagation()));
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

  /* ---------- Tournament: round robin · single / double elimination · pools + playoffs ---------- */
  const T = PBTour;
  let tour = store.get('aopb.liveTour', null);
  let obsTour = !!store.get('aopb.obsTour', false);
  function saveTour() { if (tour) store.set('aopb.liveTour', tour); else store.del('aopb.liveTour'); }
  const tname = (id) => T.teamName(tour, id);
  const mnum = (m) => '#' + (tour.matches.indexOf(m) + 1);
  const mById = (id) => tour && tour.matches.find((x) => x.id === id);
  function isFree(c) {
    const st = c.state;
    return !c.tm && (st.matchOver || (st.score[0] + st.score[1] === 0 && st.games[0] + st.games[1] === 0 && st.gameNo === 1));
  }
  function courtPush(c) {
    save(); renderCourt(c); pushObs();
    if (c.link) c.link.broadcast(Object.assign(E.publicState(c.state), { liveCourt: true, court: c.i + 1 }));
  }
  function matchSettings(names) {
    const r = tour.rules;
    return { names, target: r.target, bestOf: r.bestOf, scoring: r.scoring, mode: r.mode, courtChange: r.courtChange ? 1 : 0, players: [['', ''], ['', '']], firstServer: 0 };
  }
  function loadMatch(c, m) {
    clearTimeout(c.tourT); c.tourT = null;
    m.status = 'live'; m.court = c.i; c.tm = m.id;
    c.state = E.newMatch(matchSettings([tname(m.a), tname(m.b)]));
    saveTour(); courtPush(c);
    toast('COURT ' + (c.i + 1) + ' · ' + tname(m.a) + ' VS ' + tname(m.b));
    if (c.i === 0 && voiceOn()) PBVoice.say([{ tts: 'Next match. ' + titleCase(tname(m.a)) + ' versus ' + titleCase(tname(m.b)) + '.' }]);
  }
  function finishCourt(c) {   // put the court's finished match into the tournament (or back in the queue if it wasn't finished)
    clearTimeout(c.tourT); c.tourT = null;
    const m = mById(c.tm); c.tm = null;
    if (!m || m.status === 'done') return;
    if (c.state.matchOver) T.record(tour, m.id, c.state.gameLog.map((g) => ({ a: g.a, b: g.b })));
    else { m.status = 'ready'; m.court = null; T.resolve(tour); }
    saveTour();
  }
  function tourRelease(c) {
    clearTimeout(c.tourT); c.tourT = null;
    const m = mById(c.tm); if (m && m.status === 'live') { m.status = 'ready'; m.court = null; }
    c.tm = null; saveTour();
  }
  function fillCourts() {
    if (!tour) return 0;
    let n = 0;
    for (const c of courts) { if (!isFree(c)) continue; const m = T.nextFor(tour); if (!m) break; loadMatch(c, m); n++; }
    tourChanged();
    return n;
  }
  function tourNext(c) {   // referee tapped "New match", or the final has been on screen long enough
    finishCourt(c);
    const m = T.nextFor(tour);
    if (m) loadMatch(c, m);
    else { c.state = E.newMatch(matchSettings(['TBD', 'TBD'])); courtPush(c); }
    fillCourts();
  }
  function tourWatch(c) {
    if (!tour || !c.tm) return;
    if (c.state.matchOver && !c.tourT) c.tourT = setTimeout(() => { c.tourT = null; if (c.tm && c.state.matchOver) tourNext(c); }, 40000);
    if (!c.state.matchOver && c.tourT) { clearTimeout(c.tourT); c.tourT = null; }
  }
  function tourChanged() {
    renderTourChip(); phoneTour();
    if (!$('tourOverlay').classList.contains('hidden')) renderTour();
    courts.forEach(renderCourt); pushObs();
    const ch = tour && T.champion(tour);
    if (ch && !tour.champAt) { tour.champAt = Date.now(); saveTour(); toast('CHAMPION · ' + tname(ch)); if ($('tourOverlay').classList.contains('hidden')) openTour('bracket'); }
  }
  /* Voice: a 1-court tournament calls every score and the winner out loud, like the solo scoreboard */
  const FORMAT_INFO = {
    rr: 'Everyone plays everyone once. Most wins takes the title; ties go to point difference.',
    se: 'Lose once and you are out. Winners move up the bracket to the final. Top seeds get a bye when the team count is uneven.',
    de: 'Lose twice to be out. A first loss drops a team to the losers bracket; its winner meets the winners-bracket champion in the grand final.',
    pools: 'Teams are split into pools that play round robin. The top teams of each pool go on to a knockout playoff.'
  };
  const titleCase = (n) => String(n || '').toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
  function voiceOn() { return !!(window.PBVoice && tour && cfg.n === 1 && liveOK() && tour.voice !== 0); }
  function liveAnnounce(st, ev) {
    const V = PBVoice, call = V.callItems(E.callout(st)), gap = { gap: .3 }, s = st.settings;
    const isDef = (t) => /^TEAM [AB]$/i.test(String(s.names[t] || '').trim()) || !String(s.names[t] || '').trim() || s.names[t] === 'TBD';
    const nameItem = (t) => isDef(t) ? (t ? 'teamb' : 'teama') : { tts: titleCase(s.names[t]), fallback: t ? 'teamb' : 'teama' };
    let items = null;
    switch (ev.type) {
      case 'point': case 'undo': case 'server': items = st.gameOver || st.matchOver || st.playForServe ? null : call; break;
      case 'sideout': items = ['sideout', gap].concat(call); break;
      case 'second': items = ['second', gap].concat(call); break;
      case 'pfsStart': items = ['pfs']; break;
      case 'toss': items = ['toss', gap].concat(isDef(ev.team) ? [ev.team ? 'sf_b' : 'sf_a'] : [nameItem(ev.team), 'servesfirst'], [gap], call); break;
      case 'timeout': items = isDef(ev.team) ? [ev.team ? 'to_b' : 'to_a'] : ['timeout', nameItem(ev.team)]; break;
      case 'timein': items = ['timein', gap].concat(call); break;
      case 'pfs': items = (isDef(ev.team) ? [ev.team ? 'sf_b' : 'sf_a'] : [nameItem(ev.team), 'servesfirst']).concat([gap], call); break;
      case 'newgame': items = [st.gameNo >= 2 && st.gameNo <= 5 ? 'g' + st.gameNo : 'game', gap].concat(call); break;
      case 'game': case 'match': {
        const g = st.gameLog[st.gameLog.length - 1] || { a: 0, b: 0 };
        const ws = ev.team ? g.b : g.a, ls = ev.team ? g.a : g.b;
        const who = isDef(ev.team) ? [(ev.type === 'match' ? 'wm_' : 'wg_') + (ev.team ? 'b' : 'a')] : [nameItem(ev.team), ev.type === 'match' ? 'winsmatch' : 'winsgame'];
        items = [ev.type === 'match' ? 'match' : 'game', gap].concat(who, [gap], V.callItems(ws + '-' + ls));
        break;
      }
    }
    if (items && items.length) V.say(items);
  }
  function renderVoice() {
    const show = !!(window.PBVoice && tour && cfg.n === 1);
    $('lvVoice').classList.toggle('hidden', !show);
    if (!show) return;
    const on = tour.voice !== 0, ready = PBVoice.ready();
    $('lvVoiceTxt').textContent = !on ? 'Voice off' : ready ? 'Voice on' : 'Tap for voice';
    $('lvVoice').classList.toggle('ok', on && ready);
    $('lvVoice').classList.toggle('need', on && !ready);
  }
  $('lvVoice').onclick = () => {
    if (!tour) return;
    if (tour.voice !== 0 && !PBVoice.ready()) { PBVoice.unlock(); setTimeout(() => { PBVoice.say(PBVoice.callItems(E.callout(courts[0].state))); renderVoice(); }, 150); return; }
    tour.voice = tour.voice === 0 ? 1 : 0; saveTour(); renderVoice(); toast(tour.voice ? 'VOICE ON' : 'VOICE OFF');
  };
  if (window.PBVoice) { PBVoice.onState(renderVoice); setInterval(renderVoice, 2000); }

  function renderTourChip() {
    if (typeof renderVoice === 'function') renderVoice();
    const ch = tour && T.champion(tour), p = tour && T.progress(tour);
    $('tourChipTxt').textContent = !tour ? 'Tournament' : ch ? 'Champion · ' + tname(ch) : tour.name + ' · ' + p.done + '/' + p.total;
    $('tourBtn').classList.toggle('on', !!tour);
  }
  function readyList() {
    const order = { rr: 0, pool: 0, w: 1, l: 1, po: 2, gf: 3 };
    return tour.matches.filter((m) => m.status === 'ready').sort((x, y) => (order[x.stage] - order[y.stage]) || (x.round - y.round) || tour.matches.indexOf(x) - tour.matches.indexOf(y));
  }

  // OBS: small board in the top corner (standings or pools while they run, then who's on court / up next)
  function tourBoard() {
    if (!tour) return null;
    const ch = T.champion(tour);
    const row = (r) => [r.name, r.w, r.l, r.pd];
    const b = { name: tour.name, champ: ch ? tname(ch) : null, rows: null, pools: null, up: [] };
    const poolsLive = tour.format === 'pools' && tour.matches.some((m) => m.stage === 'pool' && m.status !== 'done');
    if (tour.format === 'rr') b.rows = T.standings(tour).slice(0, 8).map(row);
    else if (poolsLive) b.pools = tour.poolTeams.map((_, i) => T.standings(tour, i).slice(0, 5).map(row));
    b.up = tour.matches.filter((m) => m.status === 'live').map((m) => ['COURT ' + (m.court + 1), tname(m.a), tname(m.b), m.label])
      .concat(readyList().map((m) => ['NEXT', tname(m.a), tname(m.b), m.label])).slice(0, 5);
    return b;
  }

  /* Setup */
  const draft = Object.assign({ format: 'rr', pools: 2, advance: 2, target: 11, bestOf: 1, scoring: 'sideout', mode: 'doubles', courtChange: 0, name: '', teams: '' }, store.get('aopb.tourDraft', {}) || {});
  draft.courts = cfg.n;
  const SEGS = { tourFormat: 'format', tourPools: 'pools', tourAdv: 'advance', tourTarget: 'target', tourBestOf: 'bestOf', tourScoring: 'scoring', tourMode: 'mode', tourCourts: 'courts', tourCC: 'courtChange' };
  Object.keys(SEGS).forEach((id) => $(id).querySelectorAll('button').forEach((b) => b.onclick = () => {
    const k = SEGS[id]; draft[k] = /^\d+$/.test(b.dataset.v) ? Number(b.dataset.v) : b.dataset.v; renderSetup();
  }));
  const teamList = () => $('tourTeams').value.split('\n').map((x) => x.trim().toUpperCase()).filter(Boolean);
  $('tourTeams').oninput = () => { draft.teams = $('tourTeams').value; renderSetup(true); };
  $('tourName').oninput = () => { draft.name = $('tourName').value; store.set('aopb.tourDraft', draft); };
  ['tourTeams', 'tourName'].forEach((id) => $(id).addEventListener('keydown', (e) => e.stopPropagation()));
  function setupProblem(list, o) {
    o = o || draft;
    if (!['rr', 'se', 'de', 'pools'].includes(o.format)) return 'Pick a format.';
    if (list.length < 2) return 'Add at least 2 teams.';
    const dup = list.find((x, i) => list.indexOf(x) !== i); if (dup) return dup + ' is listed twice.';
    if (o.format === 'pools' && list.length < o.pools * 2) return o.pools + ' pools need at least ' + o.pools * 2 + ' teams.';
    if (list.length > 64) return 'Up to 64 teams.';
    return '';
  }
  function renderSetup(keepText) {
    Object.keys(SEGS).forEach((id) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(draft[SEGS[id]]) === b.dataset.v)));
    $('poolRow').classList.toggle('hidden', draft.format !== 'pools');
    $('tourFmtInfo').textContent = FORMAT_INFO[draft.format] || '';
    $('tourVoiceInfo').classList.toggle('hidden', draft.courts !== 1);
    if (!keepText) { $('tourTeams').value = draft.teams || ''; $('tourName').value = draft.name || ''; }
    store.set('aopb.tourDraft', draft);
    const list = teamList(), bad = setupProblem(list);
    let info = list.length + ' team' + (list.length === 1 ? '' : 's');
    if (!bad) {
      const t = T.create({ format: draft.format, teams: list, pools: draft.pools, advance: draft.advance });
      const total = T.progress(t).total;
      info += ' · ' + (draft.format === 'de' ? (2 * list.length - 2) + '–' + (2 * list.length - 1) : total) + ' matches' + (draft.format === 'pools' ? ' · ' + t.pools + ' pools, top ' + t.advance + ' go through' : '') + ' · ' + draft.courts + ' court' + (draft.courts > 1 ? 's' : '');
    }
    $('tourInfo').innerHTML = esc(info) + (bad ? '<b class="bad"> · ' + esc(bad) + '</b>' : '');
    $('tourStart').disabled = !!bad;
  }
  $('tourStart').onclick = () => {
    const list = teamList(); if (setupProblem(list)) return;
    if (draft.courts !== cfg.n) {
      const losing = courts.slice(draft.courts).filter((c) => c.remotes > 0 || c.state.score[0] + c.state.score[1] > 0);
      if (losing.length && !confirm('Use ' + draft.courts + ' court' + (draft.courts > 1 ? 's' : '') + '? ' + losing.map((c) => 'Court ' + (c.i + 1)).join(', ') + ' will be removed and its referee disconnected.')) return;
    }
    if (window.PBVoice) PBVoice.unlock();
    startTour(Object.assign({}, draft, { teams: list }));
  };
  // Start a tournament from the TV form or from the organizer's phone
  function startTour(o) {
    const list = (o.teams || []).map((x) => String(x).trim().toUpperCase().slice(0, 18)).filter(Boolean);
    const bad = setupProblem(list, o); if (bad) return bad;
    const n6 = Math.min(6, Math.max(1, Number(o.courts) || cfg.n));
    Object.assign(draft, { name: o.name || '', format: o.format, pools: Number(o.pools) || 2, advance: Number(o.advance) || 2, target: Number(o.target) || 11, bestOf: Number(o.bestOf) || 1, scoring: o.scoring === 'rally' ? 'rally' : 'sideout', mode: o.mode === 'singles' ? 'singles' : 'doubles', courtChange: o.courtChange ? 1 : 0, courts: n6, teams: list.join('\n') });
    store.set('aopb.tourDraft', draft);
    if (n6 !== cfg.n) setCourts(n6);
    tour = T.create({ name: (draft.name || 'TOURNAMENT').trim().toUpperCase().slice(0, 28), format: draft.format, teams: list, pools: draft.pools, advance: draft.advance,
      rules: { target: draft.target, bestOf: draft.bestOf, scoring: draft.scoring, mode: draft.mode, courtChange: draft.courtChange } });
    saveTour(); tab = draft.format === 'rr' || draft.format === 'pools' ? 'matches' : 'bracket';
    const n = fillCourts();
    renderTour(); toast(n ? 'TOURNAMENT ON · ' + n + ' COURT' + (n > 1 ? 'S' : '') + ' LOADED' : 'TOURNAMENT ON · COURTS LOAD WHEN FREE');
    phoneTour();
    return '';
  }
  function endTour() {
    courts.forEach((c) => { clearTimeout(c.tourT); c.tourT = null; c.tm = null; });
    tour = null; saveTour(); save(); renderTourChip(); courts.forEach(renderCourt); pushObs(); phoneTour();
    openTour();   // straight to a new tournament: same teams and settings, ready to start again
    toast('NEW TOURNAMENT · SAME TEAMS');
  }
  // What the organizer's phone shows: progress, on court / up next, standings
  function tourPhoneState() {
    if (!tour) return { t: 'tourState', tour: null, courts: cfg.n };
    const p = T.progress(tour), b = tourBoard();
    return { t: 'tourState', courts: cfg.n, tour: { name: tour.name, format: tour.format, done: p.done, total: p.total, champ: b.champ, up: b.up, rows: b.rows, pools: b.pools } };
  }
  function phoneTour() { try { if (actLink) actLink.broadcastMsg(tourPhoneState()); } catch (e) {} }

  /* Running view */
  let tab = 'matches';
  $('tourTabs').querySelectorAll('button').forEach((b) => b.onclick = () => { tab = b.dataset.v; renderTour(); });
  function srcText(src) {
    if (!src) return 'TBD';
    if (src.pool != null) return 'POOL ' + String.fromCharCode(65 + src.pool) + ' #' + (src.rank + 1);
    const m = mById(src.m); return (src.take === 'W' ? 'Winner ' : 'Loser ') + (m ? mnum(m) : '');
  }
  const side = (m, k) => m[k] != null ? tname(m[k]) : srcText(m['src' + k.toUpperCase()]);
  function scoreText(m) { return m.result && !m.result.bye ? m.result.games.map((g) => g.a + '–' + g.b).join(', ') : ''; }
  function matchRow(m) {
    const w = m.result && m.result.winner;
    const st = m.status === 'live' ? '<span class="trm-court">COURT ' + (m.court + 1) + '</span>'
      : m.status === 'ready' ? '<button class="btn trm-btn" data-score="' + m.id + '">Enter score</button>'
      : m.status === 'done' ? '<span class="trm-res">' + esc(scoreText(m)) + '</span>' : '<span class="trm-wait">Waiting</span>';
    return '<div class="trm st-' + m.status + '"><span class="trm-no">' + mnum(m) + '</span><span class="trm-lbl">' + esc(m.label) + '</span>' +
      '<span class="trm-teams"><b class="' + (w === 'a' ? 'win' : '') + '">' + esc(side(m, 'a')) + '</b><i>vs</i><b class="' + (w === 'b' ? 'win' : '') + '">' + esc(side(m, 'b')) + '</b></span>' + st + '</div>';
  }
  function tableHtml(rows, adv, title) {
    return '<div class="trt">' + (title ? '<h3>' + esc(title) + '</h3>' : '') + '<table><thead><tr><th></th><th>Team</th><th>P</th><th>W</th><th>L</th><th>+/-</th></tr></thead><tbody>' +
      rows.map((r, i) => '<tr class="' + (i < adv ? 'adv' : '') + '"><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + r.p + '</td><td>' + r.w + '</td><td>' + r.l + '</td><td>' + (r.pd > 0 ? '+' : '') + r.pd + '</td></tr>').join('') + '</tbody></table></div>';
  }
  // Bracket: cards laid out as a tree, with connector lines from each match to the one its winner plays next
  function bracketHtml(stage, title) {
    const all = tour.matches.filter((m) => m.stage === stage && !(m.a === T.BYE && m.b === T.BYE));
    if (!all.length) return '';
    const W = 214, GX = 46, H = 66, P = 30, GY = 14, TOP = 28;
    const ids = new Set(all.map((m) => m.id));
    const isBye = (m) => m.a === T.BYE || m.b === T.BYE;   // a team that goes straight through: drawn as a slim pill
    const hOf = (m) => isBye(m) ? P : H;
    const rounds = [...new Set(all.map((m) => m.round))].sort((a, b) => a - b);
    const pos = {};
    rounds.forEach((r, ci) => {
      let bottom = -GY;
      all.filter((m) => m.round === r).forEach((m) => {
        const h = hOf(m);
        const f = [m.srcA, m.srcB].filter((x) => x && x.m && ids.has(x.m) && pos[x.m]).map((x) => pos[x.m]);
        let y = f.length ? f.reduce((a, p) => a + p.c, 0) / f.length - TOP - h / 2 : bottom + GY;
        y = Math.max(y, bottom + GY);
        pos[m.id] = { x: ci * (W + GX), y: y + TOP, h, c: y + TOP + h / 2 }; bottom = y + h;
      });
    });
    const width = rounds.length * (W + GX) - GX;
    const height = Math.max(...all.map((m) => pos[m.id].y + pos[m.id].h)) + 4;
    const score = (m, k) => !m.result || m.result.bye ? '' : (m.result.games.length > 1 ? m.result.games.filter((g) => (k === 'a' ? g.a > g.b : g.b > g.a)).length : (k === 'a' ? m.result.pa : m.result.pb));
    const box = (p) => 'left:' + p.x + 'px;top:' + p.y + 'px;width:' + W + 'px;height:' + p.h + 'px';
    const card = (m) => {
      const p = pos[m.id], w = m.result && m.result.winner;
      if (isBye(m)) { const k = m.a === T.BYE ? 'b' : 'a'; return '<div class="trb-m trb-bye" style="' + box(p) + '"><span>' + esc(side(m, k)) + '</span><i>BYE</i></div>'; }
      const ln = (k) => '<div class="trb-t' + (w === k ? ' win' : w ? ' lose' : '') + (m[k] == null ? ' tbd' : '') + '"><span>' + esc(side(m, k)) + '</span><b>' + score(m, k) + '</b></div>';
      return '<div class="trb-m st-' + m.status + '" style="' + box(p) + '"><small>' + mnum(m) + (m.status === 'live' ? ' · <em>COURT ' + (m.court + 1) + ' · LIVE</em>' : m.status === 'ready' ? ' · UP NEXT' : '') + '</small>' + ln('a') + ln('b') + '</div>';
    };
    let lines = '';
    all.forEach((m) => {
      [m.srcA, m.srcB].forEach((src) => {
        if (!src || !src.m || !ids.has(src.m)) return;
        const f = all.find((x) => x.id === src.m); if (!f) return;
        const a = pos[f.id], b = pos[m.id];
        const x1 = a.x + W, y1 = a.c, x2 = b.x, y2 = b.c, xm = x1 + GX / 2;
        lines += '<path class="' + (f.status === 'done' ? 'done' : '') + '" d="M' + x1 + ' ' + y1 + 'H' + xm + 'V' + y2 + 'H' + x2 + '"/>';
      });
    });
    const heads = rounds.map((r, ci) => { const m = all.find((x) => x.round === r); return '<span class="trb-h" style="left:' + ci * (W + GX) + 'px;width:' + W + 'px">' + esc(m.label.replace(/^(WINNERS|LOSERS|PLAYOFF) · /, '')) + '</span>'; }).join('');
    return '<div class="trb"><h3>' + esc(title) + '</h3><div class="trb-scroll"><div class="trb-tree" style="width:' + width + 'px;height:' + height + 'px">' + heads +
      '<svg class="trb-lines" width="' + width + '" height="' + height + '" aria-hidden="true">' + lines + '</svg>' + all.map(card).join('') + '</div></div></div>';
  }
  function renderTour() {
    const setup = !tour;
    $('tourSetup').classList.toggle('hidden', !setup); $('tourRun').classList.toggle('hidden', setup);
    if (setup) { $('tourTitle').textContent = 'Tournament'; $('tourSub').textContent = 'Enter the teams and pick a format. Matches go to free courts by themselves, and the next match loads when a court finishes.'; renderSetup(); return; }
    const F = { rr: 'Round robin', se: 'Single elimination', de: 'Double elimination', pools: 'Pools + playoffs' }[tour.format];
    const p = T.progress(tour), r = tour.rules;
    $('tourTitle').textContent = tour.name;
    $('tourSub').textContent = F + ' · ' + tour.teams.length + ' teams · ' + p.done + ' of ' + p.total + ' matches played · game to ' + r.target + (r.bestOf > 1 ? ', best of ' + r.bestOf : '') + ' · ' + (r.scoring === 'rally' ? 'rally' : 'side-out') + ' scoring';
    const hasTable = tour.format === 'rr' || tour.format === 'pools', hasBracket = tour.format !== 'rr';
    if (tab === 'table' && !hasTable) tab = 'bracket';
    if (tab === 'bracket' && !hasBracket) tab = 'table';
    $('tourTabs').querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.v === tab); b.classList.toggle('hidden', (b.dataset.v === 'table' && !hasTable) || (b.dataset.v === 'bracket' && !hasBracket)); });
    const ch = T.champion(tour);
    $('tourChamp').classList.toggle('hidden', !ch);
    if (ch) $('tourChamp').innerHTML = '<span class="eyebrow">Champion</span><b>' + esc(tname(ch)) + '</b>';
    $('tourFill').disabled = !courts.some(isFree) || !T.nextFor(tour);
    $('tourEnd').textContent = ch ? 'New tournament' : 'End tournament';
    $('tourEnd').classList.toggle('primary', !!ch);
    let html = '';
    if (tab === 'matches') {
      const real = tour.matches.filter((m) => !(m.result && m.result.bye));
      const live = real.filter((m) => m.status === 'live'), ready = readyList(), wait = real.filter((m) => m.status === 'wait'), done = real.filter((m) => m.status === 'done').reverse();
      const sec = (t, list) => list.length ? '<h3>' + t + ' <small>' + list.length + '</small></h3>' + list.map(matchRow).join('') : '';
      html = sec('On court', live) + sec('Up next', ready) + sec('Waiting for results', wait) + sec('Results', done);
    } else if (tab === 'table') {
      html = tour.format === 'rr' ? tableHtml(T.standings(tour), 1) : '<div class="trt-grid">' + tour.poolTeams.map((_, i) => tableHtml(T.standings(tour, i), tour.advance, 'Pool ' + String.fromCharCode(65 + i))).join('') + '</div>';
    } else {
      html = tour.format === 'se' ? bracketHtml('w', 'Bracket') : tour.format === 'pools' ? bracketHtml('po', 'Playoffs')
        : bracketHtml('w', 'Winners bracket') + bracketHtml('l', 'Losers bracket') + bracketHtml('gf', 'Grand final');
    }
    $('tourView').innerHTML = html || '<p class="trn-empty">Nothing here yet.</p>';
    $('tourView').querySelectorAll('[data-score]').forEach((b) => b.onclick = () => manualScore(b.dataset.score));
  }
  function manualScore(id) {   // a match played without a referee phone
    const m = mById(id); if (!m || m.status !== 'ready') return;
    const txt = prompt('Score for ' + tname(m.a) + ' vs ' + tname(m.b) + ' (' + tname(m.a) + ' first).\nOne game: 11-7   ·   Best of 3: 11-7, 8-11, 11-9');
    if (!txt) return;
    const games = txt.split(/[,;\s]+/).filter(Boolean).map((g) => g.split(/[-–:]/).map(Number)).filter((g) => g.length === 2 && g.every((x) => x >= 0 && x < 100) && g[0] !== g[1]).map((g) => ({ a: g[0], b: g[1] }));
    if (!games.length) { toast('USE A SCORE LIKE 11-7'); return; }
    T.record(tour, id, games); saveTour(); fillCourts(); toast('RESULT SAVED');
  }
  function openTour(t) { if (t) tab = t; renderTour(); $('tourOverlay').classList.remove('hidden'); }
  $('tourBtn').onclick = () => openTour();
  $('tourClose').onclick = () => $('tourOverlay').classList.add('hidden');
  $('tourFill').onclick = () => { const n = fillCourts(); toast(n ? n + ' COURT' + (n > 1 ? 'S' : '') + ' LOADED' : 'NO FREE COURT'); };
  $('tourEnd').onclick = () => {
    if (!T.champion(tour) && !confirm('End ' + tour.name + ' and set up a new tournament? The schedule and results are cleared; the team list stays.')) return;
    endTour();
  };
  $('obsTourToggle').checked = obsTour;
  $('obsTourToggle').onchange = () => { obsTour = $('obsTourToggle').checked; store.set('aopb.obsTour', obsTour); pushObs(); };
  renderTourChip();

  /* ---------- UI bits ---------- */
  let toastT;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1800); }
  $('fsBtn').innerHTML = ICON.full;
  $('actFs').onclick = () => $('fsBtn').click();
  $('fsBtn').onclick = () => { const d = document.documentElement; if (!document.fullscreenElement) (d.requestFullscreen || function () {}).call(d); else document.exitFullscreen(); keepAwake(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ['qrOverlay', 'obsOverlay', 'tourOverlay'].forEach((id) => $(id).classList.add('hidden')); });

  // Presence: count this LIVE screen in "online now" / "courts scoring"
  let liveHandle = null;
  PBAuth.live('L-' + rand(8), { r: 'board', live: false }, () => {}).then((h) => { liveHandle = h; }).catch(() => {});
  setInterval(() => { if (liveHandle) liveHandle.update({ r: 'board', live: liveOK() && courts.some((c) => c.remotes > 0) }); }, 10000);

  /* ---------- Boot ---------- */
  let linkReady = false;
  try { sessionStorage.setItem('aopb.tabRole', 'display'); localStorage.setItem('aopb.role', 'display'); } catch (e) {}
  layout(); renderLicense(); keepAwake();
  if (tour) courts.forEach((c) => { if (c.tm && !mById(c.tm)) c.tm = null; tourWatch(c); });
  Promise.allSettled([loadScript(LIBS.qr), loadScript(LIBS.peer)]).then(() => {
    linkReady = true;
    courts.forEach((c) => { if (!c.link) startCourtLink(c); });
    startActLink(); startObs(); renderAllQr();
  });
})();
