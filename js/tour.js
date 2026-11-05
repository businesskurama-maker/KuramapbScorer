/* DinkyKong tournaments (pure logic, no DOM): round robin, single elimination, double elimination, pools + playoffs.
 * A tournament is plain JSON so the LIVE screen can save it and send it to OBS.
 *   teams:   [{ id, name }]
 *   matches: [{ id, stage, round, pool, label, a, b, srcA, srcB, status, court, result }]
 *            a / b: team id, 'BYE', or null (waiting for an earlier match)
 *            srcA / srcB: { m: matchId, take: 'W' | 'L' } or { pool, rank } for playoffs
 *            status: 'wait' | 'ready' | 'live' | 'done'
 *            result: { winner: 'a' | 'b', games: [{ a, b }], pa, pb }
 */
(function (root) {
  const BYE = 'BYE';
  let seq = 0;
  const mid = () => 'm' + (++seq).toString(36);

  function create(opts) {
    seq = 0;
    const parsed = (opts.teams || []).map((n) => typeof n === 'string' ? parseTeam(n) : { name: String(n.name || '').trim(), players: (n.players || []).filter(Boolean) }).filter((x) => x.name);
    const teams = parsed.map((x, i) => ({ id: 't' + (i + 1), name: x.name, players: x.players.slice(0, 2) }));
    const t = { v: 1, name: opts.name || 'Tournament', format: opts.format || 'rr', pools: opts.pools || 2, advance: opts.advance || 2,
      rules: Object.assign({ target: 11, bestOf: 1, scoring: 'sideout', mode: 'doubles' }, opts.rules || {}), teams, matches: [], createdAt: Date.now() };
    const ids = teams.map((x) => x.id);
    if (t.format === 'rr') t.matches = roundRobin(ids, 'rr', null);
    else if (t.format === 'se') t.matches = singleElim(ids.map((id) => ({ team: id })), 'w');
    else if (t.format === 'de') t.matches = doubleElim(ids);
    else if (t.format === 'pools') {
      const P = Math.max(2, Math.min(t.pools, Math.floor(ids.length / 2)));
      t.pools = P;
      const pools = Array.from({ length: P }, () => []);
      ids.forEach((id, i) => { const r = Math.floor(i / P), c = r % 2 ? P - 1 - (i % P) : i % P; pools[c].push(id); });   // snake seeding
      t.poolTeams = pools;
      pools.forEach((p, i) => { t.matches.push(...roundRobin(p, 'pool', i)); });
      // playoffs: pool winners meet runners-up of another pool
      const K = Math.max(1, Math.min(t.advance, Math.min(...pools.map((p) => p.length))));
      t.advance = K;
      const seeds = [];
      for (let r = 0; r < K; r++) for (let p = 0; p < P; p++) seeds.push({ src: { pool: p, rank: r } });
      t.matches.push(...singleElim(seeds, 'po'));
    }
    resolve(t);
    return t;
  }

  // Circle method: everyone plays everyone once
  function roundRobin(ids, stage, pool) {
    const list = ids.slice(); if (list.length % 2) list.push(BYE);
    const n = list.length, out = [];
    for (let r = 0; r < n - 1; r++) {
      for (let i = 0; i < n / 2; i++) {
        const a = list[i], b = list[n - 1 - i];
        if (a !== BYE && b !== BYE) out.push({ id: mid(), stage, pool, round: r + 1, label: (pool != null ? 'POOL ' + String.fromCharCode(65 + pool) + ' · ' : '') + 'R' + (r + 1), a, b, status: 'wait', court: null, result: null });
      }
      list.splice(1, 0, list.pop());
    }
    return out;
  }

  // Standard seeded bracket order for size n (1 v n, 2 v n-1 ... spread so top seeds meet last)
  function seedOrder(n) { let o = [1]; while (o.length < n) { const m = o.length * 2 + 1; o = o.flatMap((x) => [x, m - x]); } return o; }

  function singleElim(entries, stage) {
    const n = entries.length; if (n < 2) return [];
    let size = 1; while (size < n) size *= 2;
    const order = seedOrder(size), out = [];
    const slot = (k) => entries[k - 1] || { bye: true };
    let prev = [];
    const rounds = Math.log2(size);
    for (let r = 1; r <= rounds; r++) {
      const cur = [];
      const count = size / Math.pow(2, r);
      for (let i = 0; i < count; i++) {
        const m = { id: mid(), stage, round: r, label: roundName(stage, r, rounds), a: null, b: null, status: 'wait', court: null, result: null };
        if (r === 1) {
          const A = slot(order[2 * i]), B = slot(order[2 * i + 1]);
          if (A.bye) m.a = BYE; else if (A.team) m.a = A.team; else m.srcA = A.src;
          if (B.bye) m.b = BYE; else if (B.team) m.b = B.team; else m.srcB = B.src;
        } else { m.srcA = { m: prev[2 * i].id, take: 'W' }; m.srcB = { m: prev[2 * i + 1].id, take: 'W' }; }
        cur.push(m); out.push(m);
      }
      prev = cur;
    }
    return out;
  }
  function roundName(stage, r, rounds) {
    const left = rounds - r;
    const base = left === 0 ? 'FINAL' : left === 1 ? 'SEMIFINAL' : left === 2 ? 'QUARTERFINAL' : 'ROUND ' + r;
    return stage === 'po' ? 'PLAYOFF · ' + base : stage === 'w' ? base : base;
  }

  function doubleElim(ids) {
    const wb = singleElim(ids.map((id) => ({ team: id })), 'w');
    if (!wb.length) return [];
    const rounds = Math.max(...wb.map((m) => m.round));
    wb.forEach((m) => { m.label = 'WINNERS · ' + roundName('w', m.round, rounds); });
    const byRound = (r) => wb.filter((m) => m.round === r);
    const out = wb.slice();
    // losers bracket
    let lbPrev = [];
    let lr = 0;
    // L1: losers of W1 paired
    const w1 = byRound(1);
    let cur = [];
    for (let i = 0; i < w1.length; i += 2) cur.push({ id: mid(), stage: 'l', round: ++lr && 1, label: 'LOSERS · R1', a: null, b: null, srcA: { m: w1[i].id, take: 'L' }, srcB: { m: w1[i + 1] ? w1[i + 1].id : w1[i].id, take: 'L' }, status: 'wait', court: null, result: null });
    lr = 1;
    if (w1.length === 1) cur = [];   // 2 teams: no losers bracket rounds before the final
    out.push(...cur); lbPrev = cur;
    for (let r = 2; r <= rounds; r++) {
      const wl = byRound(r).slice().reverse();   // drop-ins in reverse order to avoid quick rematches
      // drop-in round: LB winners vs WB losers of round r
      const drop = [];
      if (lbPrev.length) {
        lr++;
        for (let i = 0; i < wl.length; i++) drop.push({ id: mid(), stage: 'l', round: lr, label: 'LOSERS · R' + lr, a: null, b: null, srcA: { m: lbPrev[i].id, take: 'W' }, srcB: { m: wl[i].id, take: 'L' }, status: 'wait', court: null, result: null });
        out.push(...drop);
      } else { lbPrev = wl.map((m) => ({ id: m.id, fromW: true })); continue; }
      lbPrev = drop;
      if (r < rounds && drop.length > 1) {   // consolidation round: LB winners paired
        lr++;
        const con = [];
        for (let i = 0; i < drop.length; i += 2) con.push({ id: mid(), stage: 'l', round: lr, label: 'LOSERS · R' + lr, a: null, b: null, srcA: { m: drop[i].id, take: 'W' }, srcB: { m: drop[i + 1].id, take: 'W' }, status: 'wait', court: null, result: null });
        out.push(...con); lbPrev = con;
      }
    }
    const wf = byRound(rounds)[0];
    const lbFinal = lbPrev[0];
    const gf = { id: mid(), stage: 'gf', round: 1, label: 'GRAND FINAL', a: null, b: null, srcA: { m: wf.id, take: 'W' }, srcB: lbFinal && !lbFinal.fromW ? { m: lbFinal.id, take: 'W' } : { m: wf.id, take: 'L' }, status: 'wait', court: null, result: null };
    out.push(gf);
    return out;
  }

  // "NET NINJAS: Juan, Maria"  ·  "NET NINJAS - Juan / Maria"  ·  "NET NINJAS"
  function parseTeam(line) {
    const str = String(line || '').trim(); const m = str.match(/^(.*?)\s*(?::|\s[-–]\s)\s*(.*)$/);
    const name = (m ? m[1] : str).trim().slice(0, 18);
    const players = m ? m[2].split(/\s*(?:,|\/|&|\band\b)\s*/i).map((x) => x.trim().slice(0, 16)).filter(Boolean).slice(0, 2) : [];
    return { name, players };
  }
  const teamPlayers = (t, id) => ((t.teams.find((x) => x.id === id) || {}).players || []);
  const teamName = (t, id) => id === BYE ? 'BYE' : ((t.teams.find((x) => x.id === id) || {}).name || 'TBD');
  const winnerOf = (m) => m.result ? (m.result.winner === 'a' ? m.a : m.b) : null;
  const loserOf = (m) => m.result ? (m.result.winner === 'a' ? m.b : m.a) : null;

  // Fill in teams from finished matches, auto-advance byes, mark ready matches. Call after every change.
  function resolve(t) {
    let changed = true, guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (const m of t.matches) {
        for (const side of ['a', 'b']) {
          const src = m['src' + side.toUpperCase()];
          if (m[side] != null || !src) continue;
          if (src.m) { const s = t.matches.find((x) => x.id === src.m); if (s && s.status === 'done') { m[side] = src.take === 'W' ? winnerOf(s) : loserOf(s); changed = true; } }
          else if (src.pool != null) {
            const pm = t.matches.filter((x) => x.stage === 'pool' && x.pool === src.pool);
            if (pm.length && pm.every((x) => x.status === 'done')) { const tab = standings(t, src.pool); m[side] = tab[src.rank] ? tab[src.rank].id : BYE; changed = true; }
          }
        }
        if (m.status !== 'done' && m.a != null && m.b != null && (m.a === BYE || m.b === BYE)) {
          m.result = { winner: m.a === BYE ? 'b' : 'a', games: [], pa: 0, pb: 0, bye: true }; m.status = 'done'; m.court = null; changed = true;
        }
        if (m.status === 'wait' && m.a != null && m.b != null) { m.status = 'ready'; changed = true; }
      }
      // grand final reset: if the losers-bracket champion wins the first final, play one more
      const gf = t.matches.find((x) => x.stage === 'gf' && x.round === 1);
      if (gf && gf.status === 'done' && gf.result.winner === 'b' && !t.matches.find((x) => x.stage === 'gf' && x.round === 2)) {
        t.matches.push({ id: mid() + 'r', stage: 'gf', round: 2, label: 'GRAND FINAL · RESET', a: gf.a, b: gf.b, status: 'ready', court: null, result: null }); changed = true;
      }
    }
    return t;
  }

  function record(t, matchId, games) {
    const m = t.matches.find((x) => x.id === matchId); if (!m) return t;
    let wa = 0, wb = 0, pa = 0, pb = 0;
    games.forEach((g) => { pa += g.a; pb += g.b; if (g.a > g.b) wa++; else wb++; });
    m.result = { winner: wa >= wb ? 'a' : 'b', games, pa, pb }; m.status = 'done'; m.court = null;
    return resolve(t);
  }

  // Wins, losses, point difference (round robin / one pool)
  function standings(t, pool) {
    const ids = pool == null ? t.teams.map((x) => x.id) : (t.poolTeams || [])[pool] || [];
    const row = {}; ids.forEach((id) => { row[id] = { id, name: teamName(t, id), p: 0, w: 0, l: 0, pf: 0, pa: 0 }; });
    t.matches.filter((m) => (pool == null ? m.stage === 'rr' : m.stage === 'pool' && m.pool === pool) && m.status === 'done' && !m.result.bye).forEach((m) => {
      const A = row[m.a], B = row[m.b]; if (!A || !B) return;
      A.p++; B.p++; A.pf += m.result.pa; A.pa += m.result.pb; B.pf += m.result.pb; B.pa += m.result.pa;
      if (m.result.winner === 'a') { A.w++; B.l++; } else { B.w++; A.l++; }
    });
    return Object.values(row).map((r) => Object.assign(r, { pd: r.pf - r.pa })).sort((x, y) => y.w - x.w || y.pd - x.pd || y.pf - x.pf || x.name.localeCompare(y.name));
  }

  // Next match for a free court: earliest ready match whose teams aren't busy on another court
  function nextFor(t) {
    const busy = new Set(t.matches.filter((m) => m.status === 'live').flatMap((m) => [m.a, m.b]));
    const order = { rr: 0, pool: 0, w: 1, l: 1, po: 2, gf: 3 };
    return t.matches.filter((m) => m.status === 'ready' && !busy.has(m.a) && !busy.has(m.b))
      .sort((x, y) => (order[x.stage] - order[y.stage]) || (x.round - y.round) || t.matches.indexOf(x) - t.matches.indexOf(y))[0] || null;
  }

  function champion(t) {
    if (t.format === 'rr') { const all = t.matches.every((m) => m.status === 'done'); return all && t.matches.length ? standings(t)[0].id : null; }
    const finals = t.matches.filter((m) => m.stage === (t.format === 'de' ? 'gf' : t.format === 'pools' ? 'po' : 'w'));
    const last = finals.sort((x, y) => y.round - x.round)[0];
    if (!last || last.status !== 'done') return null;
    if (t.format === 'de' && last.round === 1 && last.result.winner === 'b') return null;   // reset match pending
    return winnerOf(last);
  }

  const done = (t) => t.matches.length > 0 && t.matches.every((m) => m.status === 'done');
  const progress = (t) => ({ done: t.matches.filter((m) => m.status === 'done' && !(m.result && m.result.bye)).length, total: t.matches.filter((m) => !(m.result && m.result.bye)).length });

  const api = { parseTeam, teamPlayers, create, resolve, record, standings, nextFor, champion, done, progress, teamName, winnerOf, BYE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PBTour = api;
})(typeof window !== 'undefined' ? window : globalThis);
