/* Shared helpers: script loading with CDN fallback, wake lock, SW registration, icons. */
(function () {
  function loadScript(urls) {
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

  window.PBCommon = { seg, loadScript, LIBS, keepAwake, registerSW, store, ICON, PALETTE, esc };
})();
