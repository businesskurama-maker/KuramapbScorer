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
    firstServer: 0,
    autoSwap: true          // switch ends between games + at midpoint of deciding game
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
    return {
      v: 1,
      settings: s,
      score: [0, 0],
      games: [0, 0],
      gameNo: 1,
      gameLog: [],            // [{a,b,winner}]
      serving: s.firstServer,
      gameFirstServer: s.firstServer,
      serverNum: s.mode === 'doubles' && s.scoring === 'sideout' ? 2 : 1,
      pos: [[0, 1], [0, 1]],  // pos[team] = [player in right court, player in left court]
      serverPlayer: 0,        // index into settings.players[serving]
      swapped: false,         // false: team 0 on the left
      midSwapDone: false,
      gameOver: false,
      matchOver: false,
      winner: null,
      rallies: 0,
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
    if (!st.settings.autoSwap || st.midSwapDone) return;
    // Change ends in the deciding game (or a single-game match) when a team first reaches the midpoint.
    if (!isDecidingGame(st)) return;
    const mid = Math.ceil(st.settings.target / 2); // 6 for 11, 8 for 15, 11 for 21
    if (st.score[0] === mid || st.score[1] === mid) {
      st.swapped = !st.swapped;
      st.midSwapDone = true;
      st.lastEvent = { type: 'swap', team: null, t: Date.now(), auto: true };
    }
  }

  function rally(st, team) {
    if (st.gameOver || st.matchOver) return st;
    pushHistory(st);
    st.rallies += 1;
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
    st.serving = team;
    st.gameFirstServer = team;
    st.serverNum = st.settings.mode === 'doubles' && st.settings.scoring === 'sideout' ? 2 : 1;
    if (st.gameNo === 1) st.settings.firstServer = team;
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

  // Upgrade states saved by older versions.
  function ensure(st) {
    if (!st.pos) st.pos = [[0, 1], [0, 1]];
    if (st.serverPlayer == null) st.serverPlayer = st.pos[st.serving][0];
    st.settings.players = cleanPlayers(st.settings.players);
    if (!st.history) st.history = [];
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
      case 'new': return newMatch(Object.assign({}, st.settings, action.settings || {}, { players: cleanPlayers((action.settings || st.settings).players) }));
      default: return st;
    }
  }

  // The spoken score call, e.g. "4-2-1" (doubles side-out) or "4-2".
  function callout(st) {
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
    return p;
  }

  const api = { DEFAULT_SETTINGS, ensure, playerName, newMatch, apply, callout, serveSide, publicState, isDecidingGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PBEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
