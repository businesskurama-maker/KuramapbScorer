/* LIVE lower third ("score bug" strip, 16:2.2). Shared by the LIVE screen preview and the OBS browser source. */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Compact, display-only summary of one court (this is what travels to OBS)
  function summary(state, index, remotes) {
    const s = state.settings;
    return {
      n: index + 1,
      names: s.names.slice(0, 2), colors: s.colors.slice(0, 2),
      score: state.score.slice(0, 2), games: state.games.slice(0, 2),
      serving: state.matchOver || state.playForServe ? -1 : state.serving,
      pfs: !!state.playForServe,
      gameNo: state.gameNo, bestOf: s.bestOf, target: s.target,
      over: !!state.matchOver, winner: state.winner,
      call: window.PBEngine ? PBEngine.callout(state) : '',
      ev: state.lastEvent ? { t: state.lastEvent.t, type: state.lastEvent.type } : null,
      active: remotes > 0 || state.score[0] + state.score[1] + state.games[0] + state.games[1] > 0 || state.gameNo > 1
    };
  }

  // Courts to show on the strip: the active ones (or all, if none is active yet)
  function pick(list) { const a = list.filter((c) => c.active); return a.length ? a : list; }

  const FLASH = { point: 1, sideout: 1, second: 1, undo: 1, server: 1, pfs: 1, newgame: 1 };
  function card(c, flash) {
    const meta = c.over ? 'FINAL' : c.pfs ? 'PLAY FOR SERVE' : (c.bestOf > 1 ? 'G' + c.gameNo + ' · BO' + c.bestOf : 'TO ' + c.target);
    const row = (t) => {
      const won = c.over && c.winner === t;
      const pips = c.bestOf > 1 ? '<span class="lt-pips">' + Array.from({ length: Math.ceil(c.bestOf / 2) }, (_, i) => '<i class="' + (i < c.games[t] ? 'on' : '') + '"></i>').join('') + '</span>' : '';
      return '<div class="lt-row' + (c.serving === t ? ' srv' : '') + (won ? ' won' : '') + '" style="--c:' + esc(c.colors[t]) + '">' +
        '<span class="lt-bar"></span><span class="lt-name">' + esc(c.names[t]) + '</span>' + pips +
        '<span class="lt-ball" aria-hidden="true"></span><span class="lt-score">' + esc(c.score[t]) + '</span></div>';
    };
    const call = flash && c.call ? '<div class="lt-call" aria-live="polite">' + esc(c.call) + '</div>' : '';
    return '<div class="lt-court' + (call ? ' flash' : '') + '"><div class="lt-head"><b>COURT ' + c.n + '</b><span>' + meta + '</span></div>' + row(0) + row(1) + call + '</div>';
  }

  // The 3-number call replaces both scores for 3 s after a score or serve change (per court, per strip)
  function flashing(el, c) {
    const seen = el._seen || (el._seen = {}), until = el._until || (el._until = {});
    const t = c.ev && c.ev.t;
    if (!(c.n in seen)) seen[c.n] = t;   // first sight: no pop-up
    else if (t && t !== seen[c.n]) {
      seen[c.n] = t;
      if (FLASH[c.ev.type] && !c.over && !c.pfs) {
        until[c.n] = Date.now() + 3000;
        clearTimeout(el._ft); el._ft = setTimeout(() => { if (el._last) render(el, el._last[0], el._last[1]); }, 3050);
      }
    }
    return (until[c.n] || 0) > Date.now();
  }
  function render(el, list, opts) {
    opts = opts || {};
    el._last = [list, opts];
    const courts = pick(list || []);
    el.style.setProperty('--n', Math.max(1, courts.length));
    el.style.setProperty('--maxw', ({ 1: '52%', 2: '74%', 3: '92%' })[courts.length] || '100%');
    el.innerHTML = '<div class="lt">' +
      '<div class="lt-brand"><img src="' + esc(opts.logo || ((opts.base || '') + 'icons/dinkykong-logo.png')) + '" alt=""><span><b>' + esc(opts.caption || 'DINKYKONG') + '</b><i>LIVE</i></span></div>' +
      '<div class="lt-courts">' + (courts.length ? courts.map((c) => card(c, flashing(el, c))).join('') : '<div class="lt-wait">Waiting for courts…</div>') + '</div></div>';
  }

  window.PBStrip = { summary, render, pick };
})();
