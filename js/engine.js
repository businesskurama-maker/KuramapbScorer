/* Kurama Pickleball Scorer — scoring engine (pure, no DOM).
 * Supports traditional side-out scoring (doubles 0-0-2 start / singles) and rally scoring.
 * The display device owns the state; remotes only send actions.
 */
(function (root) {
  const DEFAULT_SETTINGS = {
    mode: 'doubles',        // 'doubles' | 'singles'
    scoring: 'sideout',     // 'sideout' | 'rally'
    target: 11,             // 11 | 15 | 21
    winBy: 2,
    bestOf: 1,              // 1 | 3 | 5
    names: ['TEAM A', 'TEAM B'],
    players: [['', ''], ['', '']], // [team][0] starts in the right-hand court
    colors: ['#39FF14', '#00E5FF'],   // electric green / electric cyan
    firstServer: 0,         // 0 | 1 | 'pfs' (play for serve: a rally decides who serves first)
    autoSwap: true,         // switch ends between games
    voice: 1,               // 1: loud voice calls the score and the winner on the scoreboard · 0: silent
    voicePack: 'classic',   // announcer voice: classic · anime (anime-style hype) · mc (deep hip-hop / arena MC)
    courtChange: 0,         // 0 (default): no court change at half · 1: change court at the half of the deciding game
    timeouts: 2,            // timeouts per team per game (0 | 1 | 2)
    tags: 0                 // 1: the remote asks why each rally ended (winner / net / out / kitchen / error) for stats
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Team A and Team B can never share a color: if they match, Team B gets the next distinct one.
  const TEAM_COLORS = ['#39FF14', '#00E5FF', '#FF2E88', '#FFE600', '#B26BFF', '#FF6B1A'];
  function distinctColors(colors) {
    const c = (colors && colors.length === 2 ? colors : DEFAULT_SETTINGS.colors).map(String);
    if (c[0].toLowerCase() !== c[1].toLowerCase()) return c;
    return [c[0], TEAM_COLORS.find((x) => x.toLowerCase() !== c[0].toLowerCase())];
  }

  function newMatch(settings) {
    const s = Object.assign(clone(DEFAULT_SETTINGS), settings ? clone(settings) : {});
    s.colors = distinctColors(s.colors);
    const pfs = s.firstServer === 'pfs';
    const first = pfs ? 0 : (s.firstServer === 1 ? 1 : 0);
    return {
      playForServe: pfs,      // true until the serve rally is played
      v: 1,
      settings: s,
      score: [0, 0],
      games: [0, 0],
      gameNo: 1,
      gameLog: [],            // [{a,b,winner}]
      serving: first,
      gameFirstServer: first,
      serverNum: s.mode === 'doubles' && s.scoring === 'sideout' ? 2 : 1,
      pos: [[0, 1], [0, 1]],  // pos[team] = [player in right court, player in left court]
      serverPlayer: 0,        // index into settings.players[serving]
      swapped: false,         // false: team 0 on the left
      midSwapDone: false,
      gameOver: false,
      matchOver: false,
      winner: null,
      rallies: 0,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),   // match id (history de-dupe)
      rallyLog: [],           // [winner, servingTeam, gameNo, secondsSinceStart, tag?] per rally, for stats
      timeouts: [s.timeouts == null ? 2 : s.timeouts, s.timeouts == null ? 2 : s.timeouts],
      timeout: null,          // { team, until } while a timeout runs
      lastEvent: null,        // {type:'point'|'sideout'|'second'|'game'|'match'|'swap', team, t}
      startedAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    };
  }

  function snapshot(st) {
    const c = Object.assign({}, st);
    delete c.history;
    return clone(c);
  }

  function pushHistory(st) {
    st.history.push(snapshot(st));
    if (st.history.length > 300) st.history.shift();
  }

  function isDecidingGame(st) {
    const need = Math.ceil(st.settings.bestOf / 2);
    return st.games[0] === need - 1 && st.games[1] === need - 1;
  }

  function checkGame(st) {
    const { target, winBy } = st.settings;
    for (const w of [0, 1]) {
      const l = 1 - w;
      if (st.score[w] >= target && st.score[w] - st.score[l] >= winBy) {
        st.gameOver = true;
        st.games[w] += 1;
        st.gameLog.push({ a: st.score[0], b: st.score[1], winner: w });
        if (st.games[w] >= Math.ceil(st.settings.bestOf / 2)) {
          st.matchOver = true;
          st.winner = w;
          st.lastEvent = { type: 'match', team: w, t: Date.now() };
        } else {
          st.lastEvent = { type: 'game', team: w, t: Date.now() };
        }
        return true;
      }
    }
    return false;
  }

  function checkMidSwap(st) {
    if (!st.settings.autoSwap || st.settings.courtChange !== 1 || st.midSwapDone) return;
    // Change ends in the deciding game (or a single-game match) when a team first reaches the midpoint.
    if (!isDecidingGame(st)) return;
    const mid = Math.ceil(st.settings.target / 2); // 6 for 11, 8 for 15, 11 for 21
    if (st.score[0] === mid || st.score[1] === mid) {
      st.swapped = !st.swapped;
      st.midSwapDone = true;
      st.lastEvent = { type: 'swap', team: null, t: Date.now(), auto: true };
    }
  }

  // Play for serve: the winner of the serve rally serves first (no point is scored).
  function serveRally(st, team) {
    pushHistory(st);
    st.playForServe = false; st.serveDecided = true;
    st.serving = team; st.gameFirstServer = team;
    st.serverNum = st.settings.mode === 'doubles' && st.settings.scoring === 'sideout' ? 2 : 1;
    st.serverPlayer = st.settings.mode === 'doubles' ? st.pos[team][0] : 0;
    st.lastEvent = { type: 'pfs', team, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }
  // Start a serve rally on a match that hasn't started yet.
  function startPfs(st) {
    if (st.gameNo > 1 || st.score[0] + st.score[1] > 0 || st.playForServe || st.gameOver || st.matchOver) return st;
    pushHistory(st);
    st.playForServe = true;
    st.lastEvent = { type: 'pfsStart', team: null, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }

  function rally(st, team) {
    if (st.gameOver || st.matchOver) return st;
    if (st.playForServe) return serveRally(st, team);
    pushHistory(st);
    st.rallies += 1;
    st.timeout = null;
    if (!st.rallyLog) st.rallyLog = [];
    st.rallyLog.push([team, st.serving, st.gameNo, Math.round((Date.now() - (st.startedAt || Date.now())) / 1000)]);
    const s = st.settings;
    const dbl = s.mode === 'doubles';
    const switchSides = (t) => { if (dbl) st.pos[t] = [st.pos[t][1], st.pos[t][0]]; };
    if (s.scoring === 'rally') {
      st.score[team] += 1;
      if (team !== st.serving) {
        st.serving = team;
        st.serverPlayer = dbl ? st.pos[team][st.score[team] % 2 === 0 ? 0 : 1] : 0;
        st.lastEvent = { type: 'sideout', team, t: Date.now() };
      } else { switchSides(team); st.lastEvent = { type: 'point', team, t: Date.now() }; }
      st.serverNum = 1;
    } else if (team === st.serving) {
      st.score[team] += 1;
      switchSides(team); // server swaps courts with partner and keeps serving
      st.lastEvent = { type: 'point', team, t: Date.now() };
    } else if (dbl && st.serverNum === 1) {
      st.serverNum = 2;
      st.serverPlayer = 1 - st.serverPlayer;
      st.lastEvent = { type: 'second', team: st.serving, t: Date.now() };
    } else {
      st.serving = 1 - st.serving;
      st.serverNum = 1;
      st.serverPlayer = dbl ? st.pos[st.serving][0] : 0; // player in the right court serves first
      st.lastEvent = { type: 'sideout', team: st.serving, t: Date.now() };
    }
    if (!checkGame(st)) checkMidSwap(st);
    st.updatedAt = Date.now();
    return st;
  }

  function nextGame(st) {
    if (!st.gameOver || st.matchOver) return st;
    pushHistory(st);
    st.gameNo += 1;
    st.score = [0, 0];
    st.gameOver = false;
    st.midSwapDone = false;
    st.gameFirstServer = 1 - st.gameFirstServer;
    st.serving = st.gameFirstServer;
    st.serverNum = st.settings.mode === 'doubles' && st.settings.scoring === 'sideout' ? 2 : 1;
    st.pos = [[0, 1], [0, 1]];
    st.serverPlayer = 0;
    st.timeouts = [st.settings.timeouts, st.settings.timeouts]; st.timeout = null;
    if (st.settings.autoSwap) st.swapped = !st.swapped;
    st.lastEvent = { type: 'newgame', team: null, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }

  function undo(st) {
    const prev = st.history.pop();
    if (!prev) return st;
    const h = st.history;
    const restored = Object.assign(prev, { history: h });
    restored.lastEvent = { type: 'undo', team: null, t: Date.now() };
    restored.updatedAt = Date.now();
    return restored;
  }

  function swap(st) {
    pushHistory(st);
    st.swapped = !st.swapped;
    st.lastEvent = { type: 'swap', team: null, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }

  // Before the first rally of a game: choose which team serves first.
  function setServer(st, team) {
    if (st.score[0] + st.score[1] > 0 || st.gameOver) return st;
    pushHistory(st);
    st.playForServe = false;
    st.serving = team;
    st.gameFirstServer = team;
    st.serverNum = st.settings.mode === 'doubles' && st.settings.scoring === 'sideout' ? 2 : 1;
    if (st.gameNo === 1 && st.settings.firstServer !== 'pfs') st.settings.firstServer = team;
    st.serverPlayer = st.settings.mode === 'doubles' ? st.pos[team][0] : 0;
    st.lastEvent = { type: 'server', team, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }

  // Cosmetic changes that don't reset the match.
  function rename(st, names, colors, players) {
    if (names) st.settings.names = names.map((n, i) => String(n || (i ? 'TEAM B' : 'TEAM A')).slice(0, 18));
    if (colors) st.settings.colors = distinctColors(colors);
    if (players) st.settings.players = cleanPlayers(players);
    st.updatedAt = Date.now();
    return st;
  }

  function cleanPlayers(p) {
    return [0, 1].map((t) => [0, 1].map((i) => String((p && p[t] && p[t][i]) || '').trim().slice(0, 16)));
  }

  // Correct who stands where: swaps the two players of a team (the server label follows the court).
  function partners(st, team) {
    if (st.settings.mode !== 'doubles') return st;
    pushHistory(st);
    st.pos[team] = [st.pos[team][1], st.pos[team][0]];
    if (st.serving === team) st.serverPlayer = 1 - st.serverPlayer;
    st.lastEvent = { type: 'partners', team, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }

  // Timeouts: each team has settings.timeouts per game; a timeout runs 60 s (the scoreboard counts it down)
  function callTimeout(st, team) {
    if (st.gameOver || st.matchOver || !st.timeouts || st.timeouts[team] < 1 || (st.timeout && st.timeout.until > Date.now())) return st;
    pushHistory(st);
    st.timeouts[team] -= 1;
    st.timeout = { team, until: Date.now() + 60000 };
    st.lastEvent = { type: 'timeout', team, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }
  function endTimeout(st) {
    if (!st.timeout) return st;
    st.timeout = null;
    st.lastEvent = { type: 'timein', team: null, t: Date.now() };
    st.updatedAt = Date.now();
    return st;
  }
  // Coin toss: a random team serves first (only before the first point)
  function toss(st) {
    if (st.gameNo > 1 || st.score[0] + st.score[1] > 0 || st.gameOver || st.matchOver) return st;
    const team = (crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(1))[0] : Math.random() * 256) % 2;
    setServer(st, team);
    st.playForServe = false; st.serveDecided = true;
    st.lastEvent = { type: 'toss', team, t: Date.now() };
    return st;
  }
  // Why the last rally ended (optional, for stats)
  function tagRally(st, tag) {
    const r = st.rallyLog && st.rallyLog[st.rallyLog.length - 1];
    if (r && ['winner', 'net', 'out', 'kitchen', 'error'].includes(tag)) { r[4] = tag; st.updatedAt = Date.now(); }
    return st;
  }

  // Match stats from the rally log
  function stats(st) {
    const log = st.rallyLog || [], rally = st.settings.scoring === 'rally';
    const t = () => ({ points: 0, servePts: 0, rallies: 0, recvRallies: 0, recvWon: 0, run: 0, tags: {} });
    const T = [t(), t()]; let cur = -1, len = 0;
    for (const r of log) {
      const [w, srv] = r, scored = rally || w === srv;
      T[w].rallies++;
      const rcv = 1 - srv; T[rcv].recvRallies++; if (w === rcv) T[rcv].recvWon++;
      if (r[4]) T[w].tags[r[4]] = (T[w].tags[r[4]] || 0) + 1;
      if (scored) {
        T[w].points++; if (w === srv) T[w].servePts++;
        if (w === cur) len++; else { cur = w; len = 1; }
        T[w].run = Math.max(T[w].run, len);
      }
    }
    T.forEach((x) => { x.sideoutPct = x.recvRallies ? Math.round(100 * x.recvWon / x.recvRallies) : 0; });
    const last = log[log.length - 1];
    return { teams: T, rallies: log.length, minutes: last ? Math.max(1, Math.round(last[3] / 60)) : 0 };
  }

  // Upgrade states saved by older versions.
  function ensure(st) {
    if (!st.pos) st.pos = [[0, 1], [0, 1]];
    if (st.serverPlayer == null) st.serverPlayer = st.pos[st.serving][0];
    st.settings.players = cleanPlayers(st.settings.players);
    if (!st.history) st.history = [];
    if (st.playForServe == null) st.playForServe = false;
    if (st.settings.courtChange == null) st.settings.courtChange = 0;
    if (st.settings.voice == null) st.settings.voice = 1;
    if (st.settings.timeouts == null) st.settings.timeouts = 2;
    if (st.settings.tags == null) st.settings.tags = 0;
    if (st.settings.winBy == null) st.settings.winBy = 2;
    if (!st.id) st.id = (st.startedAt || Date.now()).toString(36) + 'x';
    if (!st.rallyLog) st.rallyLog = [];
    if (!st.timeouts) st.timeouts = [st.settings.timeouts, st.settings.timeouts];
    delete st.settings.midSwap;
    // Old default palette → new electric defaults
    const old = { '#d7f03c': '#39FF14', '#4fc3f7': '#00E5FF' };
    st.settings.colors = distinctColors(st.settings.colors.map((c) => old[String(c).toLowerCase()] || c));
    return st;
  }

  function playerName(st, team, idx) {
    const n = st.settings.players[team][idx];
    if (n) return n;
    return st.settings.mode === 'doubles' ? 'Player ' + (idx + 1) : st.settings.names[team];
  }

  function apply(st, action) {
    ensure(st);
    switch (action && action.a) {
      case 'rally': return rally(st, action.team === 1 ? 1 : 0);
      case 'undo': return undo(st);
      case 'swap': return swap(st);
      case 'next': return nextGame(st);
      case 'server': return setServer(st, action.team === 1 ? 1 : 0);
      case 'rename': return rename(st, action.names, action.colors, action.players);
      case 'partners': return partners(st, action.team === 1 ? 1 : 0);
      case 'pfs': return startPfs(st);
      case 'voice':
        if ('on' in action) st.settings.voice = action.on ? 1 : 0;
        if (action.pack && /^(classic|anime|mc)$/.test(action.pack)) st.settings.voicePack = action.pack;
        return st;
      case 'timeout': return callTimeout(st, action.team === 1 ? 1 : 0);
      case 'timein': return endTimeout(st);
      case 'toss': return toss(st);
      case 'tag': return tagRally(st, action.tag);
      case 'rules': {   // win-by / timeouts / rally reasons can change mid-match without a reset
        const r = action.rules || {};
        if (r.winBy === 1 || r.winBy === 2) st.settings.winBy = r.winBy;
        if ([0, 1, 2].includes(r.timeouts)) { const d = r.timeouts - st.settings.timeouts; st.settings.timeouts = r.timeouts; st.timeouts = st.timeouts.map((x) => Math.max(0, Math.min(r.timeouts, x + d))); }
        if (r.tags === 0 || r.tags === 1) st.settings.tags = r.tags;
        return st;
      }
      case 'midswap': st.settings.courtChange = action.on ? 1 : 0; return st;   // change court at half: on/off, no reset
      case 'new': return newMatch(Object.assign({}, st.settings, action.settings || {}, { players: cleanPlayers((action.settings || st.settings).players) }));
      default: return st;
    }
  }

  // The spoken score call, e.g. "4-2-1" (doubles side-out) or "4-2".
  function callout(st) {
    if (st.playForServe) return '';
    const srv = st.serving, rcv = 1 - srv;
    const base = st.score[srv] + '-' + st.score[rcv];
    if (st.settings.mode === 'doubles' && st.settings.scoring === 'sideout') return base + '-' + st.serverNum;
    return base;
  }

  // Doubles: the side the current server is standing on. Singles: right when the server's score is even.
  function serveSide(st) {
    if (st.settings.mode === 'doubles' && st.pos) return st.pos[st.serving][0] === st.serverPlayer ? 'RIGHT' : 'LEFT';
    return st.score[st.serving] % 2 === 0 ? 'RIGHT' : 'LEFT';
  }

  function publicState(st) {
    const p = snapshot(st);
    p.canUndo = st.history.length > 0;
    p.call = callout(st);
    p.hasPlayers = st.settings.players.some((t) => t.some(Boolean));
    p.serverName = playerName(st, st.serving, st.serverPlayer);
    // court[team] = [{name, side:'R'|'L', serving}]
    p.court = [0, 1].map((t) => (st.settings.mode === 'doubles' ? st.pos[t] : [0]).map((idx, k) => ({
      name: playerName(st, t, idx), side: k === 0 ? 'R' : 'L', serving: st.serving === t && st.serverPlayer === idx
    })));
    p.serveSide = serveSide(st);
    p.deciding = isDecidingGame(st);
    p.pfs = !!st.playForServe;
    return p;
  }

  /* Game point / match point: the team that wins the game (or the match) with its next rally.
   * Side-out scoring: only the serving team can score, so only it can be on game point. Rally scoring: either team. */
  function pointFor(st) {
    if (!st || st.gameOver || st.matchOver || st.playForServe) return null;
    const s = st.settings, need = Math.ceil((s.bestOf || 1) / 2), winBy = s.winBy || 2;
    const teams = s.scoring === 'rally' ? [0, 1] : [st.serving];
    for (const t of teams) {
      const mine = st.score[t] + 1, theirs = st.score[1 - t];
      if (mine >= s.target && mine - theirs >= winBy) return { team: t, kind: st.games[t] + 1 >= need ? 'match' : 'game' };
    }
    return null;
  }
  const api = { pointFor, DEFAULT_SETTINGS, ensure, playerName, newMatch, apply, callout, serveSide, publicState, isDecidingGame, stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PBEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
