/* Scoreboard announcer: a loud female voice calls the score after every rally and announces the winner.
 * Numbers and phrases are pre-recorded clips (sounds/voice/*.mp3) so it sounds the same on every TV, laptop and tablet.
 * Custom team names are spoken with the device's own speech voice (a female one when available). */
(function () {
  const BASE = 'sounds/voice/';
  const KEYS = Array.from({ length: 31 }, (_, n) => 'n' + n).concat(['sideout', 'second', 'game', 'match', 'winsgame', 'winsmatch', 'teama', 'teamb', 'servesfirst', 'gameno', 'pfs']);
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
  function speakTTS(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve(false);
      try {
        const u = new SpeechSynthesisUtterance(text); const v = pickVoice();
        if (v) u.voice = v; u.lang = (v && v.lang) || 'en-US'; u.rate = 1; u.pitch = 1.1; u.volume = 1;
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
        const b = bufs[it]; if (!b) continue;
        const src = ctx.createBufferSource(); src.buffer = b; src.connect(out); src.start(t); active.push(src);
        t += b.duration + .05;
      } else if (it.gap) t += it.gap;
      else if (it.tts) {
        await sleep((t - ctx.currentTime) * 1000); if (my !== gen) return;
        const ok = await speakTTS(it.tts);
        if (my !== gen) return;
        t = ctx.currentTime + .05;
        if (!ok && it.fallback && bufs[it.fallback]) { const src = ctx.createBufferSource(); src.buffer = bufs[it.fallback]; src.connect(out); src.start(t); active.push(src); t += bufs[it.fallback].duration + .05; }
      }
    }
  }
  const num = (n) => 'n' + Math.max(0, Math.min(30, n | 0));
  const callItems = (call) => String(call || '').split('-').filter((x) => x !== '').map((x) => num(+x));

  window.PBVoice = {
    say, num, callItems, unlock, load,
    ready: () => !!ctx && ctx.state === 'running',
    supported: !!AC,
    onState: (f) => listeners.push(f)
  };
})();
