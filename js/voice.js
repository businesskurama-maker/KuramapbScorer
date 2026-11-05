/* Scoreboard announcer: a loud female voice calls the score after every rally and announces the winner.
 * Numbers and phrases are pre-recorded clips (sounds/voice/*.mp3) so it sounds the same on every TV, laptop and tablet.
 * Custom team names are spoken with the device's own speech voice (a female one when available). */
(function () {
  const BASE = 'sounds/voice/';
  const KEYS = Array.from({ length: 31 }, (_, n) => 'n' + n).concat(['g2', 'g3', 'g4', 'g5', 'sideout', 'second', 'game', 'match', 'winsgame', 'winsmatch', 'teama', 'teamb', 'servesfirst', 'pfs', 'wg_a', 'wg_b', 'wm_a', 'wm_b', 'sf_a', 'sf_b', 'timeout', 'timein', 'toss', 'to_a', 'to_b']);
  // Whole score calls ("four, two, one") are single natural recordings, fetched the first time they are needed
  const pending = {};
  function fetchClip(k) {
    if (bufs[k]) return Promise.resolve(bufs[k]);
    if (pending[k]) return pending[k];
    if (!ensureCtx()) return Promise.resolve(null);
    return (pending[k] = fetch(BASE + (k[0] === 'c' ? 'c/' + k.slice(1) : k) + '.mp3').then((r) => { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .then((a) => new Promise((res, rej) => ctx.decodeAudioData(a, res, rej))).then((b) => (bufs[k] = b)).catch(() => null));
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, out = null, bufs = {}, loading = null, gen = 0, active = [];
  const listeners = [];

  function ensureCtx() {
    if (ctx || !AC) return ctx;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = .003; comp.release.value = .12;
    const gain = ctx.createGain(); gain.gain.value = 1.6;   // loud, the limiter in the clips keeps it clean
    comp.connect(gain); gain.connect(ctx.destination); out = comp;
    ctx.onstatechange = () => listeners.forEach((f) => f());
    return ctx;
  }
  function load() {
    if (loading) return loading;
    if (!ensureCtx()) return (loading = Promise.resolve());
    loading = Promise.all(KEYS.map((k) => fetch(BASE + k + '.mp3').then((r) => r.arrayBuffer())
      .then((a) => new Promise((res, rej) => ctx.decodeAudioData(a, res, rej))).then((b) => { bufs[k] = b; }).catch(() => {})));
    return loading;
  }
  function unlock() {
    ensureCtx(); if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    load();
    try { if (window.speechSynthesis && !unlock.tts) { unlock.tts = true; const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
  }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach((e) => document.addEventListener(e, unlock, { capture: true, passive: true }));

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  function stopAll() {
    active.forEach((s) => { try { s.stop(); } catch (e) {} }); active = [];
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
  }

  // Female speech voice for team names (device voices differ, so pick by common female voice names)
  const FEMALE = /female|woman|samantha|victoria|karen|moira|tessa|fiona|serena|ava|allison|susan|zira|aria|jenny|michelle|hazel|libby|sonia|natasha|catherine|kate|google us english|google uk english female/i;
  function pickVoice() {
    if (!window.speechSynthesis) return null;
    const vs = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    return vs.find((v) => FEMALE.test(v.name) && !/male(?!.*female)/i.test(v.name.replace(/female/i, ''))) || vs.find((v) => FEMALE.test(v.name)) || vs[0] || null;
  }
  if (window.speechSynthesis) { try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => {}; } catch (e) {} }
  let it_rate = 0;
  function speakTTS(text, rate) {
    it_rate = rate || 0;
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve(false);
      try {
        const u = new SpeechSynthesisUtterance(text); const v = pickVoice();
        if (v) u.voice = v; u.lang = (v && v.lang) || 'en-US'; u.rate = it_rate || .9; u.pitch = 1.05; u.volume = 1;
        let done = false; const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
        u.onend = () => fin(true); u.onerror = () => fin(false);
        speechSynthesis.speak(u); setTimeout(() => fin(true), 400 + text.length * 120);
      } catch (e) { resolve(false); }
    });
  }

  // items: clip key | { gap: seconds } | { tts: 'Name', fallback: 'teama' }
  async function say(items) {
    const my = ++gen; stopAll();
    await load(); if (my !== gen || !ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    let t = ctx.currentTime + .05;
    for (const it of items) {
      if (my !== gen) return;
      if (typeof it === 'string') {
        let b = bufs[it];
        if (!b) { b = await fetchClip(it); if (my !== gen) return; if (!b) { if (it[0] === 'c') { const fb = it.slice(1).split('-').map((x) => 'n' + x); for (const k of fb) { const bb = bufs[k]; if (!bb) continue; const src = ctx.createBufferSource(); src.buffer = bb; src.connect(out); t = Math.max(t, ctx.currentTime + .03); src.start(t); active.push(src); t += bb.duration + .12; } } continue; } t = Math.max(t, ctx.currentTime + .03); }
        const src = ctx.createBufferSource(); src.buffer = b; src.connect(out); src.start(t); active.push(src);
        t += b.duration + .12;
      } else if (it.gap) t += it.gap;
      else if (it.chime) {   // two-tone "ding-dong" before an announcement
        t = Math.max(t, ctx.currentTime + .03);
        [[1046.5, 0], [784, .32]].forEach(([f, d]) => {
          const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(.5, t + d + .02); g.gain.exponentialRampToValueAtTime(.001, t + d + .9);
          o.connect(g); g.connect(out); o.start(t + d); o.stop(t + d + 1); active.push(o);
        });
        t += 1.25;
      }
      else if (it.tts) {
        await sleep((t - ctx.currentTime) * 1000); if (my !== gen) return;
        const ok = await speakTTS(it.tts, it.rate);
        if (my !== gen) return;
        t = ctx.currentTime + .05;
        if (!ok && it.fallback && bufs[it.fallback]) { const src = ctx.createBufferSource(); src.buffer = bufs[it.fallback]; src.connect(out); src.start(t); active.push(src); t += bufs[it.fallback].duration + .05; }
      }
    }
    await sleep((t - ctx.currentTime) * 1000);   // resolves when everything has been spoken
    return my === gen;
  }
  const num = (n) => 'n' + Math.max(0, Math.min(30, n | 0));
  // "4-2-1" -> one natural clip; scores past 21 fall back to single numbers
  const callItems = (call) => { const p = String(call || '').split('-').filter((x) => x !== '').map(Number); if (!p.length) return []; if (p.every((x) => x >= 0 && x <= 21) && (p.length === 2 || (p.length === 3 && p[2] >= 1 && p[2] <= 2))) return ['c' + p.join('-')]; return p.map(num); };
  const prefetch = (call) => { const it = callItems(call); if (it.length === 1) fetchClip(it[0]); };

  window.PBVoice = {
    say, num, callItems, unlock, load, prefetch,
    ready: () => !!ctx && ctx.state === 'running',
    supported: !!AC,
    onState: (f) => listeners.push(f)
  };
})();
