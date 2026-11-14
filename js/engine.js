/* Kurama Pickleball Scorer — scoring engine (pure, no DOM).
 * Supports traditional side-out scoring (doubles 0-0-2 start / singles) and rally scoring.
 * The display device owns the state; remotes only send actions.
 */
(function (root) {
  const DEFAULT_SETTINGS = {
    mode: 'doubles',        // 'doubles' | 'singles'
    label: '',              // match name / category shown after the court number (e.g. MEN'S DOUBLES · SEMIFINAL)
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
    voicePack: 'classic',   // announcer voice: classic · anime (anime-style hype) 
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
    const sn = snapshot(st); delete sn.queue;
    st.history.push(sn);
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
    const restored = Object.assign(prev, { history: h, queue: st.queue });
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

  /* ---------- Open play: manual paddle queue ----------
     Players (or teams) line up. The front of the line is called onto the court: 4 players = 2 pairs (doubles),
     2 players (singles) or 2 teams. After the game EVERYONE on court goes to the back of the line (mixed so
     partners change) and the next ones are called. Loops until the session time is up (the last game finishes). */
  const qClean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toUpperCase().slice(0, n);
  function qNew() { return { on: false, done: false, kind: 'players', minutes: 120, line: [], court: [], seq: 0, games: 0, endsAt: 0, startedAt: 0, calledAt: 0 }; }
  function qNeed(st) { const q = st.queue; return q.kind === 'teams' ? 2 : (st.settings.mode === 'singles' ? 2 : 4); }
  // the next players taken from the front of the line → names / players for a new match
  function qMatchFor(st, group) {
    const q = st.queue;
    if (q.kind === 'teams') return { names: group.map((t) => t.name.slice(0, 18)), players: group.map((t) => [t.p1 || '', t.p2 || '']) };
    if (group.length === 2) return { names: group.map((p) => p.name.slice(0, 18)), players: group.map((p) => [p.name, '']) };
    const A = [group[0], group[1]], B = [group[2], group[3]];
    const nm = (t) => (t[0].name.split(' ')[0] + ' & ' + t[1].name.split(' ')[0]).slice(0, 18);
    return { names: [nm(A), nm(B)], players: [A.map((p) => p.name), B.map((p) => p.name)] };
  }
  function qCall(st) {
    const q = st.queue, need = qNeed(st);
    if (q.line.length < need) { q.court = []; return st; }
    const group = q.line.splice(0, need);
    q.court = group; q.games += 1; q.calledAt = Date.now();
    const m = qMatchFor(st, group);
    const next = newMatch(Object.assign({}, st.settings, { names: m.names, players: m.players, firstServer: 0 }));
    next.queue = q;
    next.lastEvent = { type: 'qcall', team: null, t: Date.now() };
    return next;
  }
  // everyone who just played goes to the back of the line; winners and losers alternate so pairs change
  function qBack(st) {
    const q = st.queue, c = q.court || []; let back = c;
    if (q.kind !== 'teams' && c.length === 4) {
      const w = st.matchOver && st.winner === 1 ? 1 : 0, W = w ? [c[2], c[3]] : [c[0], c[1]], L = w ? [c[0], c[1]] : [c[2], c[3]];
      back = [W[0], L[0], W[1], L[1]];
    } else if (st.matchOver && st.winner === 1) back = c.slice().reverse();
    return back;
  }
  function qReturn(st) { const q = st.queue; if (!(q.court || []).length) return; q.line = q.line.concat(qBack(st)); q.court = []; }
  // who will be called next (counts the players now on court, who go to the back of the line)
  function qPreview(st) { const q = st.queue, n = qNeed(st), all = q.line.concat(q.on ? qBack(st) : []); return all.length >= n ? qMatchFor(st, all.slice(0, n)) : null; }
  function queueAct(st, a) {
    if (!st.queue) st.queue = qNew();
    const q = st.queue, now = Date.now();
    switch (a.a) {
      case 'q_kind': if (!q.on && /^(players|teams)$/.test(a.kind) && a.kind !== q.kind) { q.kind = a.kind; q.line = []; } break;
      case 'q_minutes': q.minutes = Math.max(0, Math.min(720, Math.round(Number(a.minutes) || 0))); if (q.on && q.startedAt) q.endsAt = q.minutes ? q.startedAt + q.minutes * 60000 : 0; break;
      case 'q_add': {
        if (q.line.length + q.court.length >= 80) break;
        const name = qClean(a.name, q.kind === 'teams' ? 18 : 16); if (!name) break;
        const e = { id: 'q' + (++q.seq), name };
        if (q.kind === 'teams') { e.p1 = qClean(a.p1, 16); e.p2 = qClean(a.p2, 16); }
        q.line.push(e); break;
      }
      case 'q_remove': q.line = q.line.filter((e) => e.id !== a.id); break;
      case 'q_move': { const i = q.line.findIndex((e) => e.id === a.id), j = i + (a.dir < 0 ? -1 : 1); if (i >= 0 && j >= 0 && j < q.line.length) { const t = q.line[i]; q.line[i] = q.line[j]; q.line[j] = t; } break; }
      case 'q_shuffle': for (let i = q.line.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = q.line[i]; q.line[i] = q.line[j]; q.line[j] = t; } break;
      case 'q_clear': if (!q.on) { q.line = []; q.court = []; q.done = false; q.games = 0; } break;
      case 'q_start':
        if (q.on || q.line.length < qNeed(st)) break;
        q.on = true; q.done = false; q.games = 0; q.startedAt = now; q.endsAt = q.minutes ? now + q.minutes * 60000 : 0;
        return qCall(st);
      case 'q_next': {   // game finished (or skipped): rotate and call the next players
        if (!q.on) break;
        qReturn(st);
        if (q.endsAt && now >= q.endsAt) { q.on = false; q.done = true; st.lastEvent = { type: 'qdone', team: null, t: now }; break; }
        return qCall(st);
      }
      case 'q_end': qReturn(st); q.on = false; q.done = true; st.lastEvent = { type: 'qdone', team: null, t: now }; break;
      default: return st;
    }
    st.updatedAt = now;
    return st;
  }

  function apply(st, action) {
    ensure(st);
    if (action && /^q_/.test(action.a || '')) return queueAct(st, action);
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
        if (action.pack && /^(classic|anime|mc)$/.test(action.pack)) st.settings.voicePack = action.pack === 'mc' ? 'classic' : action.pack;
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
      case 'label': st.settings.label = String(action.text == null ? '' : action.text).replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40); st.updatedAt = Date.now(); return st;   // match name / category, no reset
      case 'midswap': st.settings.courtChange = action.on ? 1 : 0; return st;   // change court at half: on/off, no reset
      case 'new': { const nm = newMatch(Object.assign({}, st.settings, action.settings || {}, { players: cleanPlayers((action.settings || st.settings).players) })); if (st.queue) nm.queue = st.queue; return nm; }
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
    if (st.queue) { p.queue = clone(st.queue); p.queue.need = qNeed(st); p.queue.next = qPreview(st); }
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
