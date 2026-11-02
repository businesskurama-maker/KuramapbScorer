/* Device link: WebRTC data channels via PeerJS (public signalling server), plus a
 * a relay fallback (same-device BroadcastChannel + internet relay via Supabase Realtime) for networks
 * where WebRTC can't connect (mobile data, strict routers) and for two tabs on one device.
 * Display = host (owns state). Remote = client (sends actions, receives state).
 */
(function () {
  const PREFIX = 'archieomega-pb-';
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function makeCode() {
    let c = '';
    const r = crypto.getRandomValues(new Uint8Array(6));
    for (const b of r) c += ALPHABET[b % ALPHABET.length];
    return c;
  }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }

  /* Relay transport: same-device BroadcastChannel + internet relay through Supabase Realtime.
   * Same interface as BroadcastChannel (postMessage / onmessage / close). Messages are de-duplicated. */
  function makeRelay(code) {
    const seen = new Map(); let handler = null, net = null, closed = false; const queue = [];
    const bc = 'BroadcastChannel' in window ? new BroadcastChannel(PREFIX + code) : null;
    const deliver = (m) => {
      if (!m) return;
      if (m.mid) { if (seen.has(m.mid)) return; seen.set(m.mid, Date.now()); if (seen.size > 400) { const cut = Date.now() - 60000; for (const [k, t] of seen) if (t < cut) seen.delete(k); } }
      if (handler) handler({ data: m });
    };
    if (bc) bc.onmessage = (e) => deliver(e.data);
    if (window.PBAuth && PBAuth.relay) PBAuth.relay('dk-link-' + code, deliver).then((r) => {
      if (closed) { r && r.close(); return; }
      net = r; if (net) queue.splice(0).forEach((m) => net.send(m));
    }).catch(() => {});
    return {
      set onmessage(f) { handler = f; },
      postMessage(m) {
        m = Object.assign({ mid: Math.random().toString(36).slice(2) + Date.now().toString(36) }, m);
        if (bc) bc.postMessage(m);
        if (net) net.send(m); else if (queue.length < 30) queue.push(m);
      },
      close() { closed = true; if (bc) bc.close(); if (net) net.close(); }
    };
  }

  function peerOpts() {
    return {
      debug: 0,
      config: { iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ] }
    };
  }

  /* ---------------- Host (display) ---------------- */
  function host({ code, onAction, onMessage, onStatus, getState }) {
    const conns = new Set();
    let peer = null, failures = 0, destroyed = false;
    const bc = makeRelay(code);

    const status = (s, extra) => onStatus && onStatus(Object.assign({ state: s, remotes: conns.size + (bcRemotes.size), code }, extra || {}));
    const bcRemotes = new Map(); // id -> lastSeen

    function sendAll(msg) {
      const data = JSON.stringify(msg);
      for (const c of conns) { try { c.open && c.send(data); } catch (e) {} }
      if (bc && bcRemotes.size) bc.postMessage({ to: 'remote', data });
    }

    function handle(raw, reply, id) {
      let msg; try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
      if (!msg) return;
      if (msg.t === 'hello' || msg.t === 'sync') reply({ t: 'state', s: getState() });
      else if (msg.t === 'action') onAction(msg.action, reply, id);
      else if (msg.t === 'ping') reply({ t: 'pong' });
      else if (onMessage) onMessage(msg, reply, id);
    }

    if (bc) {
      bc.onmessage = (e) => {
        const m = e.data; if (!m || m.to !== 'host') return;
        const isNew = !bcRemotes.has(m.from);
        bcRemotes.set(m.from, Date.now());
        handle(m.data, (r) => bc.postMessage({ to: 'remote', for: m.from, data: JSON.stringify(r) }), 'bc:' + m.from);
        if (isNew) status('online', { joined: true });
      };
      setInterval(() => { // forget silent same-device remotes
        const now = Date.now(); let changed = false;
        for (const [k, t] of bcRemotes) if (now - t > 15000) { bcRemotes.delete(k); changed = true; }
        if (changed) status(peer && peer.open ? 'online' : 'offline');
      }, 5000);
    }

    function start() {
      if (destroyed) return;
      if (typeof Peer === 'undefined') { status('nolib'); return; }
      status('connecting');
      peer = new Peer(PREFIX + code, peerOpts());
      peer.on('open', () => { failures = 0; status('online'); });
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          conns.add(conn); status('online', { joined: true });
          conn.send(JSON.stringify({ t: 'state', s: getState() }));
        });
        conn.on('data', (d) => handle(d, (r) => { try { conn.send(JSON.stringify(r)); } catch (e) {} }, 'p:' + conn.connectionId));
        const drop = () => { if (conns.delete(conn)) status(peer && peer.open ? 'online' : 'offline'); };
        conn.on('close', drop); conn.on('error', drop);
      });
      peer.on('disconnected', () => { status('reconnecting'); setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 1500); });
      peer.on('error', (err) => {
        const t = err && err.type;
        if (t === 'unavailable-id') {
          // Usually our own previous session still registered after a reload — retry, then rotate code.
          failures++;
          try { peer.destroy(); } catch (e) {}
          if (failures > 40) { status('newcode'); return; }   // ~2 minutes of retries before giving up on this code
          status('connecting', { retry: failures });
          setTimeout(start, 3000);
        } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
          status('reconnecting');
          try { peer.destroy(); } catch (e) {}
          setTimeout(start, 4000);
        }
      });
    }
    start();
    window.addEventListener('online', () => { if (!peer || peer.destroyed || peer.disconnected) start(); });

    return {
      broadcast(state) { sendAll({ t: 'state', s: state }); },
      broadcastMsg(msg) { sendAll(msg); },
      get remotes() { return conns.size + bcRemotes.size; },
      destroy() { destroyed = true; try { peer && peer.destroy(); } catch (e) {} if (bc) bc.close(); }
    };
  }

  /* ---------------- Client (remote) ---------------- */
  function client({ code, onState, onStatus, onMessage }) {
    const id = Math.random().toString(36).slice(2);
    let peer = null, conn = null, destroyed = false, lastMsg = 0, bcLive = false, retryT = null, relayAt = 0;
    const peerUp = () => !!(conn && conn.open);
    const bc = makeRelay(code);
    // Report one combined status: "connected" while EITHER WebRTC or the relay works.
    // WebRTC retries in the background must not flip a working relay link to "reconnecting".
    let shown = '';
    const status = (st) => {
      if (st !== 'connected' && (peerUp() || bcLive)) st = 'connected';
      if (st === shown) return;
      shown = st; onStatus && onStatus(st);
    };

    function onData(raw) {
      let m; try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
      lastMsg = Date.now();
      if (m.t === 'state') onState(m.s);
      else if (m.t !== 'pong' && onMessage) onMessage(m);
    }

    if (bc) {
      bc.onmessage = (e) => {
        const m = e.data; if (!m || m.to !== 'remote' || (m.for && m.for !== id)) return;
        relayAt = Date.now(); bcLive = true;
        if (peerUp() && !m.for) return;            // WebRTC already delivers broadcasts; avoid duplicates
        onData(m.data); status('connected');
      };
      bc.postMessage({ to: 'host', from: id, data: JSON.stringify({ t: 'hello' }) });
      setInterval(() => {
        if (destroyed) return;
        if (bcLive && Date.now() - relayAt > 15000) { bcLive = false; status('lost'); }
        if (!peerUp()) bc.postMessage({ to: 'host', from: id, data: JSON.stringify({ t: bcLive ? 'ping' : 'hello' }) });
      }, 4000);
    }

    function connect() {
      if (destroyed) return;
      if (conn && conn.open) return;
      status('connecting');
      try { conn = peer.connect(PREFIX + code, { reliable: true }); } catch (e) { scheduleRetry(); return; }
      const thisConn = conn;
      const timeout = setTimeout(() => { if (!thisConn.open) { try { thisConn.close(); } catch (e) {} scheduleRetry(); } }, 9000);
      conn.on('open', () => { clearTimeout(timeout); status('connected'); conn.send(JSON.stringify({ t: 'hello' })); });
      conn.on('data', onData);
      conn.on('close', () => { if (conn === thisConn) { if (bc) bc.postMessage({ to: 'host', from: id, data: JSON.stringify({ t: 'hello' }) }); status('lost'); scheduleRetry(); } });
      conn.on('error', () => { if (conn === thisConn) scheduleRetry(); });
    }
    function scheduleRetry() {
      if (destroyed || retryT) return;
      if (!bcLive) status('lost');
      retryT = setTimeout(() => { retryT = null; ensurePeer(); }, bcLive ? 15000 : 2000);
    }
    function ensurePeer() {
      if (destroyed) return;
      if (typeof Peer === 'undefined') { if (!bcLive) status('nolib'); return; }
      if (peer && peer.open) { connect(); return; }
      if (peer && peer.disconnected && !peer.destroyed) { peer.reconnect(); return; }
      peer = new Peer(peerOpts());
      peer.on('open', connect);
      peer.on('disconnected', () => setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500));
      peer.on('error', (err) => {
        if (err && err.type === 'peer-unavailable') { if (!bcLive) status('nodisplay'); }
        if (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error')) {
          try { peer.destroy(); } catch (e) {} peer = null;
        }
        scheduleRetry();
      });
    }
    ensurePeer();

    // Keep-alive / stale detection
    setInterval(() => {
      if (conn && conn.open) { try { conn.send(JSON.stringify({ t: 'ping' })); } catch (e) {} }
      if (peerUp() && lastMsg && Date.now() - lastMsg > 15000) { try { conn.close(); } catch (e) {} status('lost'); }
    }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { if (!conn || !conn.open) ensurePeer(); else conn.send(JSON.stringify({ t: 'sync' })); }
    });
    window.addEventListener('online', ensurePeer);

    return {
      send(action) {
        const data = JSON.stringify({ t: 'action', action });
        let sent = false;
        if (conn && conn.open) { conn.send(data); sent = true; }
        else if (bc && bcLive) { bc.postMessage({ to: 'host', from: id, data }); sent = true; }
        return sent;
      },
      sendMsg(msg) {
        const data = JSON.stringify(msg);
        if (conn && conn.open) { conn.send(data); return true; }
        if (bc && bcLive) { bc.postMessage({ to: 'host', from: id, data }); return true; }
        return false;
      },
      destroy() { destroyed = true; try { peer && peer.destroy(); } catch (e) {} if (bc) bc.close(); }
    };
  }

  window.PBLink = { host, client, makeCode, normCode, PREFIX };
})();
