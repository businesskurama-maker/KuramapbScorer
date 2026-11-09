/* Shared helpers: script loading with CDN fallback, wake lock, SW registration, icons. */
(function () {
  const loading = {};   // each library loads once, even if several parts of the page ask at the same time
  function loadScript(urls) {
    const key = urls.join('|');
    if (!loading[key]) loading[key] = loadScriptOnce(urls).catch((e) => { delete loading[key]; throw e; });
    return loading[key];
  }
  function loadScriptOnce(urls) {
    return new Promise((resolve, reject) => {
      const list = urls.slice();
      (function next() {
        const u = list.shift();
        if (!u) return reject(new Error('all sources failed'));
        const s = document.createElement('script');
        s.src = u; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = () => resolve(u);
        s.onerror = () => { s.remove(); next(); };
        document.head.appendChild(s);
      })();
    });
  }

  const LIBS = {
    peer: [
      'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
      'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
      'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
    ],
    qr: [
      'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
      'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
      'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js'
    ]
  };

  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* not allowed until user gesture, or unsupported */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !wakeLock) keepAwake(); });

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  const ICON = {
    ball: '<svg viewBox="0 0 40 40" class="ball" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="currentColor"/><g fill="#0b1228" opacity=".55"><circle cx="13" cy="12" r="2.4"/><circle cx="23" cy="9" r="2.4"/><circle cx="30" cy="17" r="2.4"/><circle cx="20" cy="19" r="2.4"/><circle cx="10" cy="22" r="2.4"/><circle cx="27" cy="27" r="2.4"/><circle cx="17" cy="29" r="2.4"/></g></svg>',
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    serve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><circle cx="11" cy="15" r="1" fill="currentColor"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };

  const PALETTE = ['#39FF14', '#00E5FF', '#FF2E88', '#FFE600', '#B26BFF', '#FF6B1A', '#FFFFFF'];

  /* Classic seven-segment LED digits as SVG. Unlit segments stay faintly visible ("ghost 8").
   * str: digits, '-' or ' '. pad: minimum number of digit cells (leading cells are blank-but-ghosted). */
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
  const W = 60, H = 100, T = 12, G = 1.6, GAP = 16, SKEW = 7;
  function hseg(cy, x1, x2) { const h = T / 2; return [[x1, cy], [x1 + h, cy - h], [x2 - h, cy - h], [x2, cy], [x2 - h, cy + h], [x1 + h, cy + h]]; }
  function vseg(cx, y1, y2) { const h = T / 2; return [[cx, y1], [cx + h, y1 + h], [cx + h, y2 - h], [cx, y2], [cx - h, y2 - h], [cx - h, y1 + h]]; }
  const L = T / 2, R = W - T / 2, TOP = T / 2, MID = H / 2, BOT = H - T / 2;
  const SHAPES = {
    a: hseg(TOP, L + G, R - G), g: hseg(MID, L + G, R - G), d: hseg(BOT, L + G, R - G),
    f: vseg(L, TOP + G, MID - G), b: vseg(R, TOP + G, MID - G), e: vseg(L, MID + G, BOT - G), c: vseg(R, MID + G, BOT - G)
  };
  function seg(str, pad) {
    str = String(str);
    while (str.length < (pad || 0)) str = ' ' + str;
    const chars = str.split('');
    const width = chars.length * W + (chars.length - 1) * GAP + SKEW * 2;
    let out = '';
    chars.forEach((ch, i) => {
      const on = SEG[ch] != null ? SEG[ch] : '';
      const ox = SKEW + i * (W + GAP);
      for (const k of 'abcdefg') {
        const pts = SHAPES[k].map(([x, y]) => (x + ox + (MID - y) * SKEW / MID).toFixed(1) + ',' + y.toFixed(1)).join(' ');
        out += '<polygon class="' + (on.includes(k) ? 'on' : 'off') + '" points="' + pts + '"/>';
      }
    });
    return '<svg class="seg7" viewBox="0 -2 ' + width.toFixed(1) + ' ' + (H + 4) + '" role="img" aria-label="' + str.trim() + '">' + out + '</svg>';
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Splash screen: DinkyKong logo for 5 seconds, then fade out
  (function splash() {
    const el = document.getElementById('splash'); if (!el) return;
    let seen = false; try { seen = el.dataset.once && sessionStorage.getItem('aopb.splash'); } catch (e) {}   // app launch: always; remote: once per visit
    if (seen || /[?&]menu=1/.test(location.search)) { el.remove(); return; }
    try { sessionStorage.setItem('aopb.splash', '1'); } catch (e) {}
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, 5000);
  })();

  /* "Install app" helper: wires any button to the browser's install prompt, with iPhone / TV / menu fallbacks. */
  let deferredInstall = null; const installBtns = [];
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; installBtns.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; installBtns.forEach((f) => f(true)); });
  function installHelp() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'On iPhone / iPad (Safari): tap the Share button, then “Add to Home Screen”.';
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua)) return 'In Safari on Mac: choose File › “Add to Dock”.';
    if (/Android TV|AFT|SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|GoogleTV/i.test(ua)) return 'On a TV: open the browser menu and choose “Add to home” or “Bookmark”, or just keep this page open full screen. On a laptop or phone use Chrome or Edge to install.';
    if (/Firefox/.test(ua)) return 'Firefox can’t install apps on most devices. Open this page in Chrome or Edge, then tap “Install app”.';
    return 'Open the browser menu (⋮ or the install icon in the address bar) and choose “Install app” or “Add to Home screen”.';
  }
  function installButton(btn, opts) {
    if (!btn) return;
    opts = opts || {};
    const update = (done) => { btn.classList.toggle('hidden', !!done || isStandalone()); };
    installBtns.push(update); update();
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (deferredInstall) { const p = deferredInstall; deferredInstall = null; p.prompt(); try { const r = await p.userChoice; if (r.outcome === 'accepted') update(true); } catch (err) {} return; }
      (opts.onHelp || alert)(installHelp());
    });
  }

  /* Donation confirmation hours: 8:00 AM – 10:00 PM, Philippine time */
  const HOURS = { open: 8, close: 22, label: '8:00 AM – 10:00 PM' };
  function phHour() {
    try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Manila' }).format(new Date())) % 24; }
    catch (e) { return (new Date().getUTCHours() + 8) % 24; }
  }
  const approvalOpen = () => { const h = phHour(); return h >= HOURS.open && h < HOURS.close; };

  /* "🟢 18 online now · 🏓 5 courts scoring · 👥 342 players" */
  function liveText(s) {
    const n = (x) => Number(x || 0).toLocaleString();
    const parts = ['<span class="lv-dot"></span><b>' + n(s.online) + '</b> online now'];
    if (s.courts) parts.push('<b>' + n(s.courts) + '</b> ' + (s.courts === 1 ? 'court' : 'courts') + ' scoring');
    if (s.players) parts.push('<b>' + n(s.players) + '</b> players joined');
    return parts.join('<i>·</i>');
  }

  // LIVE trial codes are shown as DK-XXXX-XXXX
  const fmtTrial = (c) => { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return c.length === 10 ? c.slice(0, 2) + '-' + c.slice(2, 6) + '-' + c.slice(6) : c; };

  /* All typed text in the app is CAPITALIZED (names, teams, titles, notes, codes).
     Emails, passwords, URLs and numbers are left alone; add data-nocaps to opt out. */
  (function capsEverywhere() {
    const SKIP = /^(email|password|url|number|tel|date|datetime-local|time|month|week|color|range|file|checkbox|radio|hidden|submit|button)$/i;
    const want = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !SKIP.test(el.type || 'text'))) && !el.hasAttribute('data-nocaps') && !el.readOnly;
    const st = document.createElement('style');
    st.textContent = 'input:not([type]),input[type=text],input[type=search],textarea{text-transform:uppercase}input[data-nocaps],textarea[data-nocaps]{text-transform:none}input::placeholder,textarea::placeholder{text-transform:none}';
    (document.head || document.documentElement).appendChild(st);
    document.addEventListener('input', (e) => {
      const el = e.target; if (!want(el) || e.isComposing) return;
      const v = el.value, up = v.toUpperCase(); if (v === up) return;
      const a = el.selectionStart, b = el.selectionEnd; el.value = up;
      try { el.setSelectionRange(a, b); } catch (x) {}
    }, true);
  })();

  window.PBCommon = { fmtTrial, liveText, HOURS, approvalOpen, seg, loadScript, LIBS, keepAwake, registerSW, store, ICON, PALETTE, esc, installButton, installHelp, isStandalone };
})();
