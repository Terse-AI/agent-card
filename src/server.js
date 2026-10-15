'use strict';
/**
 * server.js — the directory. Hosts cards, discovery, channels and a realtime
 * inbox stream.
 *
 * THE ONE IDEA (same as a social card, minus the form): an agent drafts your
 * card from what it already knows, you review and publish, and publishing is the
 * moment a code exists and the card becomes findable. Review happens BEFORE
 * publish, never after.
 *
 * WHAT THIS ADDS OVER a pull-based inbox: GET /v1/inbox/stream is a Server-Sent
 * Events channel. A connection request or a message to you is pushed down it the
 * instant it lands, which is what lets a local bridge wake an agent session
 * instead of polling. See bridge.js.
 */
const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const { createStore } = require('./store');
const { cardPage } = require('./render');
const L = require('./limits');
const {
  sha, uuid, nowIso, mintCode, normaliseHandle, handleFromName,
} = require('./ids');

/* ── field shaping ──────────────────────────────────────────────────────── */
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const multiline = (v, n) => (typeof v === 'string'
  ? v.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n) : '');
const bool = (v, dflt) => (v === undefined || v === null ? dflt : !!v);

function dataUrl(v, maxBytes) {
  const s = typeof v === 'string' ? v : '';
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return '';
  return s.length <= maxBytes ? s : '';
}
function safeLink(l) {
  if (!l || typeof l !== 'object') return null;
  const url = str(l.url, 300);
  if (!/^https?:\/\/[^\s<>"']+$/i.test(url)) return null;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  return { label: str(l.label, 24) || host, url };
}

/** The fields an agent or human may write, clipped one by one. `partial` keeps
 *  an edit that names only a headline from blanking the bio. */
function sanitizeCard(body, { partial = false } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const pick = (k, fn, dflt = undefined) => (partial && !has(k) ? dflt : fn(body[k]));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };

  set('display_name', pick('display_name', (v) => str(v, 48) || null));
  set('headline', pick('headline', (v) => str(v, 120) || null));
  set('bio', pick('bio', (v) => multiline(v, L.MAX_BIO) || null));
  set('location', pick('location', (v) => str(v, 48) || null));
  set('agent_kind', pick('agent_kind', (v) => str(v, 24).toLowerCase() || null));
  set('agent_name', pick('agent_name', (v) => str(v, 32) || null));
  set('avatar', pick('avatar', (v) => dataUrl(v, L.MAX_AVATAR_BYTES) || null));
  set('skills', pick('skills', (v) => arr(v).slice(0, L.MAX_SKILLS).map((s) => str(s, 28)).filter(Boolean)));
  set('stack', pick('stack', (v) => arr(v).slice(0, L.MAX_STACK).map((s) => str(s, 24)).filter(Boolean)));
  set('links', pick('links', (v) => arr(v).slice(0, L.MAX_LINKS).map(safeLink).filter(Boolean)));
  return out;
}

function tooBig(card) {
  const n = JSON.stringify(card).length;
  return n > L.MAX_CARD_BYTES;
}

function publicCard(p) {
  if (!p) return null;
  return {
    handle: p.handle || null, code: p.code || null,
    display_name: p.display_name || null, headline: p.headline || null,
    bio: p.bio || null, location: p.location || null,
    skills: p.skills || [], stack: p.stack || [], links: p.links || [],
    agent_kind: p.agent_kind || null, agent_name: p.agent_name || null,
    avatar: p.avatar || null, views: p.views || 0, published_at: p.published_at || null,
  };
}
function ownerCard(p) {
  if (!p) return null;
  return {
    ...publicCard(p),
    status: p.status, auto_accept: !!p.auto_accept, discoverable: !!p.discoverable,
    drafted_by: p.drafted_by || null,
    created_at: p.created_at || null, updated_at: p.updated_at || null,
  };
}

function createServer(storeOrFile) {
  const store = (storeOrFile && typeof storeOrFile === 'object' && storeOrFile.getProfile)
    ? storeOrFile : createStore(storeOrFile);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.disable('x-powered-by');

  const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`)
    .replace(/\/$/, '');

  /* ── realtime inbox (SSE) ────────────────────────────────────────────────
     identity hash -> set of open responses. push() fans an event out to every
     device the owner has listening. */
  const listeners = new Map();
  function push(identity, event, data) {
    const set = listeners.get(identity);
    if (!set || !set.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) { try { res.write(frame); } catch { /* dropped on close */ } }
  }

  /* ── identity ────────────────────────────────────────────────────────────
     The raw secret arrives in a header and is hashed here; the hash is the key
     everywhere and the raw value is never stored or echoed back. */
  function requireIdentity(req, res, next) {
    const raw = req.headers['x-agent-identity'] || req.query.identity;
    if (!raw) return res.status(401).json({ error: 'Missing identity. Send x-agent-identity.' });
    req.idHash = sha(raw.toString());
    next();
  }
  function optionalIdentity(req, _res, next) {
    const raw = req.headers['x-agent-identity'] || req.query.identity;
    req.idHash = raw ? sha(raw.toString()) : null;
    next();
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'agent-card', now: nowIso() }));

  /* ── the card ────────────────────────────────────────────────────────── */

  // POST /v1/card/draft — the agent's move. Always lands as a draft; no argument
  // makes this publish, on purpose.
  app.post('/v1/card/draft', requireIdentity, (req, res) => {
    const body = req.body || {};
    const { handle, error } = normaliseHandle(body.handle);
    if (error) return res.status(400).json({ error });
    if (handle) {
      const taken = store.getProfileByHandle(handle);
      if (taken && taken.identity !== req.idHash) return res.status(409).json({ error: `@${handle} is taken` });
    }
    const card = sanitizeCard(body);
    if (!card.display_name) return res.status(400).json({ error: 'display_name is required' });
    if (tooBig(card)) return res.status(413).json({ error: 'Card too large', max: L.MAX_CARD_BYTES });

    const existing = store.getProfile(req.idHash);
    const now = nowIso();
    store.upsertProfile(req.idHash, {
      ...card,
      handle: handle || (existing ? existing.handle : null),
      drafted_by: 'agent',
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    });
    res.json({
      ok: true,
      profile: ownerCard(store.getProfile(req.idHash)),
      next: 'Review and publish with `agent-card publish`. Nothing is public until you do.',
    });
  });

  app.get('/v1/card/me', requireIdentity, (req, res) => {
    const p = store.getProfile(req.idHash);
    if (!p) return res.status(404).json({ error: 'No card yet' });
    res.json({ profile: ownerCard(p), unread: store.countUnread(req.idHash) });
  });

  // PATCH /v1/card/me — the human's edit during review (and the toggles).
  app.patch('/v1/card/me', requireIdentity, (req, res) => {
    const p = store.getProfile(req.idHash);
    if (!p) return res.status(404).json({ error: 'No card yet' });
    const body = req.body || {};
    const patch = sanitizeCard(body, { partial: true });

    if (Object.prototype.hasOwnProperty.call(body, 'handle')) {
      const n = normaliseHandle(body.handle);
      if (n.error) return res.status(400).json({ error: n.error });
      if (n.handle) {
        const taken = store.getProfileByHandle(n.handle);
        if (taken && taken.identity !== req.idHash) return res.status(409).json({ error: `@${n.handle} is taken` });
      }
      patch.handle = n.handle;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'auto_accept')) patch.auto_accept = bool(body.auto_accept);
    if (Object.prototype.hasOwnProperty.call(body, 'discoverable')) patch.discoverable = bool(body.discoverable);
    if (tooBig(patch)) return res.status(413).json({ error: 'Card too large', max: L.MAX_CARD_BYTES });

    patch.updated_at = nowIso();
    store.upsertProfile(req.idHash, patch);
    res.json({ ok: true, profile: ownerCard(store.getProfile(req.idHash)) });
  });

  // POST /v1/card/publish — the human's decision, and the moment a code exists.
  app.post('/v1/card/publish', requireIdentity, (req, res) => {
    const p = store.getProfile(req.idHash);
    if (!p) return res.status(404).json({ error: 'No card yet' });
    if (!p.display_name) return res.status(400).json({ error: 'Add a name before publishing' });

    let handle = p.handle;
    if (!handle) handle = handleFromName(p.display_name, (h) => !!store.getProfileByHandle(h));

    let code = p.code;
    for (let i = 0; i < 6 && !code; i++) {
      const cand = mintCode();
      if (!store.getProfileByCode(cand)) code = cand;
    }
    if (!code) return res.status(503).json({ error: 'Could not mint a code — try again' });

    store.publishProfile(req.idHash, { code, handle, published_at: nowIso(), updated_at: nowIso() });
    const fresh = store.getProfile(req.idHash);
    res.json({
      ok: true, profile: ownerCard(fresh), code: fresh.code, handle: fresh.handle,
      share_url: fresh.handle ? `${PUBLIC_URL}/@${fresh.handle}` : `${PUBLIC_URL}/c/${fresh.code}`,
    });
  });

  app.post('/v1/card/unpublish', requireIdentity, (req, res) => {
    if (!store.getProfile(req.idHash)) return res.status(404).json({ error: 'No card yet' });
    store.unpublishProfile(req.idHash, nowIso());
    res.json({ ok: true, profile: ownerCard(store.getProfile(req.idHash)) });
  });

  app.post('/v1/card/rotate-code', requireIdentity, (req, res) => {
    if (!store.getProfile(req.idHash)) return res.status(404).json({ error: 'No card yet' });
    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const cand = mintCode();
      if (!store.getProfileByCode(cand)) code = cand;
    }
    if (!code) return res.status(503).json({ error: 'Could not mint a code — try again' });
    store.rotateCode(req.idHash, code, nowIso());
    res.json({ ok: true, code });
  });

  app.delete('/v1/card/me', requireIdentity, (req, res) => {
    store.deleteProfile(req.idHash);
    res.json({ ok: true });
  });

  /* ── reading other cards ─────────────────────────────────────────────── */
  function resolve(ref) {
    const r = (ref || '').toString().trim().replace(/^@/, '').toLowerCase();
    const byCode = r.startsWith('agt_');
    const row = byCode ? store.getProfileByCode(r) : store.getProfileByHandle(r);
    return { row, byCode };
  }

  app.get('/v1/card/:ref', optionalIdentity, (req, res) => {
    const { row, byCode } = resolve(req.params.ref);
    if (!row || row.status !== 'published') return res.status(404).json({ error: 'No such card' });
    // A handle only resolves for a discoverable card; a code always resolves —
    // that is the point of handing someone a code.
    if (!byCode && !row.discoverable) return res.status(404).json({ error: 'No such card' });
    if (!req.idHash || req.idHash !== row.identity) store.bumpViews(row.identity);

    let connection = null;
    if (req.idHash && req.idHash !== row.identity) {
      const edge = store.findConnection(req.idHash, row.identity);
      if (edge) connection = shapeConnection(edge, req.idHash);
    }
    res.json({
      card: publicCard(row),
      is_me: !!req.idHash && req.idHash === row.identity,
      accepts_agents: !!row.auto_accept,
      connection,
    });
  });

  // The A2A-style card: point a stranger's toolchain at one URL and it knows what
  // it is talking to without learning our schema first.
  app.get('/v1/card/:ref/agent.json', (req, res) => {
    const { row } = resolve(req.params.ref);
    if (!row || row.status !== 'published') return res.status(404).json({ error: 'No such card' });
    res.set('Cache-Control', 'public, max-age=120');
    res.json({
      protocolVersion: '0.3.0',
      name: row.agent_name || row.display_name,
      description: row.headline || row.bio || `${row.display_name} on agent-card`,
      url: `${PUBLIC_URL}/v1`,
      provider: { organization: 'agent-card', url: PUBLIC_URL },
      version: '1.0.0',
      agentCard: {
        code: row.code, handle: row.handle, auto_accept: !!row.auto_accept,
        connect: `${PUBLIC_URL}/v1/connect`,
        page: row.handle ? `${PUBLIC_URL}/@${row.handle}` : `${PUBLIC_URL}/c/${row.code}`,
      },
      skills: (row.skills || []).map((s) => ({
        id: s.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: s, description: s, tags: [s],
      })),
      capabilities: { streaming: true, pushNotifications: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    });
  });

  // QR of the share URL — SVG so it scales and stays crisp in print.
  app.get('/v1/card/:ref/qr.svg', async (req, res) => {
    const { row } = resolve(req.params.ref);
    if (!row || row.status !== 'published') return res.status(404).type('text/plain').send('No such card');
    const url = row.handle ? `${PUBLIC_URL}/@${row.handle}` : `${PUBLIC_URL}/c/${row.code}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'public, max-age=300').type('image/svg+xml').send(svg);
  });

  app.get('/v1/directory', optionalIdentity, (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase().slice(0, 48);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const offset = Math.max(0, Math.min(2000, parseInt(req.query.offset, 10) || 0));
    const { total, rows } = store.listProfiles({ q, limit, offset });
    res.json({
      total,
      cards: rows.map((r) => ({
        ...publicCard(r),
        avatar: r.avatar || null,
        bio: (r.bio || '').slice(0, 160) || null,
        is_me: !!req.idHash && req.idHash === r.identity,
      })),
    });
  });

  /* ── channels ────────────────────────────────────────────────────────── */
  function shapeConnection(edge, me) {
    const outgoing = edge.a_identity === me;
    const peerId = outgoing ? edge.b_identity : edge.a_identity;
    const peer = store.getProfile(peerId);
    return {
      id: edge.id, status: edge.status, direction: outgoing ? 'outgoing' : 'incoming',
      opened_via: edge.opened_via, note: edge.note || null,
      created_at: edge.created_at, responded_at: edge.responded_at || null,
      peer: peer ? publicCard(peer) : null,
    };
  }

  // POST /v1/connect  { code | handle, note? } — present a code, get a pending
  // edge and one line in front of a human (or an open channel if they opted in).
  app.post('/v1/connect', requireIdentity, (req, res) => {
    const body = req.body || {};
    const { row: target, byCode } = resolve(body.code || body.handle);
    if (!target || target.status !== 'published') return res.status(404).json({ error: 'No such card' });
    if (!byCode && !target.discoverable) return res.status(404).json({ error: 'No such card' });
    if (target.identity === req.idHash) return res.status(400).json({ error: 'That is your own card' });

    // You must have a published card before asking for a channel: a request from
    // nobody is one the other side cannot judge, and is what enumeration looks like.
    const mine = store.getProfile(req.idHash);
    if (!mine || mine.status !== 'published') {
      return res.status(403).json({ error: 'Publish your own card first — the other side has to see who is asking' });
    }

    const existing = store.findConnection(req.idHash, target.identity);
    if (existing) {
      if (existing.status === 'blocked') return res.status(403).json({ error: 'Not available' });
      return res.json({ ok: true, connection: shapeConnection(existing, req.idHash), already: true });
    }
    if (store.countConnectionsSince(req.idHash, 3600e3) >= L.CONNECT_PER_HOUR) {
      return res.status(429).json({ error: 'Too many connection requests this hour', max: L.CONNECT_PER_HOUR });
    }

    const auto = !!target.auto_accept;
    const edge = {
      id: uuid(), a_identity: req.idHash, b_identity: target.identity,
      status: auto ? 'accepted' : 'pending', opened_via: byCode ? 'code' : 'directory',
      note: str(body.note, 200) || null, created_at: nowIso(), responded_at: auto ? nowIso() : null,
    };
    store.insertConnection(edge);
    push(target.identity, 'connect_request', {
      connection: shapeConnection(edge, target.identity), auto,
    });
    res.json({ ok: true, connection: shapeConnection(store.getConnection(edge.id), req.idHash), opened: auto });
  });

  app.get('/v1/connections', requireIdentity, (req, res) => {
    const rows = store.listConnections(req.idHash);
    res.json({ connections: rows.map((r) => shapeConnection(r, req.idHash)), unread: store.countUnread(req.idHash) });
  });

  app.post('/v1/connections/:id/respond', requireIdentity, (req, res) => {
    const action = (req.body?.action || '').toString();
    const status = { accept: 'accepted', decline: 'declined', block: 'blocked' }[action];
    if (!status) return res.status(400).json({ error: 'action must be accept, decline or block' });
    const ok = store.respondConnection(req.params.id, req.idHash, status, nowIso());
    if (!ok) return res.status(404).json({ error: 'No pending request of yours by that id' });
    const edge = store.getConnection(req.params.id);
    if (status === 'accepted') push(edge.a_identity, 'connect_accepted', { connection: shapeConnection(edge, edge.a_identity) });
    res.json({ ok: true, connection: shapeConnection(edge, req.idHash) });
  });

  app.delete('/v1/connections/:id', requireIdentity, (req, res) => {
    if (!store.deleteConnection(req.params.id, req.idHash)) return res.status(404).json({ error: 'No such connection' });
    res.json({ ok: true });
  });

  function myEdge(id, me) {
    const edge = store.getConnection(id);
    if (!edge) return null;
    if (edge.a_identity !== me && edge.b_identity !== me) return null;
    return edge;
  }

  // POST /v1/connections/:id/messages — messages need an accepted channel.
  app.post('/v1/connections/:id/messages', requireIdentity, (req, res) => {
    const edge = myEdge(req.params.id, req.idHash);
    if (!edge) return res.status(404).json({ error: 'No such connection' });
    if (edge.status !== 'accepted') return res.status(403).json({ error: 'That channel is not open yet' });
    const text = multiline(req.body?.body, L.MAX_MESSAGE);
    if (!text) return res.status(400).json({ error: 'body is required' });
    if (store.countMessagesSince(req.idHash, 3600e3) >= L.MESSAGES_PER_HOUR) {
      return res.status(429).json({ error: 'Too many messages this hour', max: L.MESSAGES_PER_HOUR });
    }
    const msg = {
      id: uuid(), connection_id: edge.id, from_identity: req.idHash,
      from_kind: req.body?.from_kind === 'human' ? 'human' : 'agent',
      body: text, created_at: nowIso(),
    };
    store.insertMessage(msg);
    const to = edge.a_identity === req.idHash ? edge.b_identity : edge.a_identity;
    push(to, 'message', {
      connection_id: edge.id, from_kind: msg.from_kind, body: text, created_at: msg.created_at,
      from: publicCard(store.getProfile(req.idHash)),
    });
    res.json({ ok: true, message: { id: msg.id, body: text, from_kind: msg.from_kind, mine: true, created_at: msg.created_at } });
  });

  app.get('/v1/connections/:id/messages', requireIdentity, (req, res) => {
    const edge = myEdge(req.params.id, req.idHash);
    if (!edge) return res.status(404).json({ error: 'No such connection' });
    const rows = store.listMessages(edge.id);
    store.markRead(edge.id, req.idHash);
    res.json({
      connection: shapeConnection(edge, req.idHash),
      messages: rows.map((m) => ({ id: m.id, body: m.body, from_kind: m.from_kind, mine: m.from_identity === req.idHash, created_at: m.created_at })),
    });
  });

  // GET /v1/inbox/stream — the realtime channel a local bridge holds open.
  app.get('/v1/inbox/stream', requireIdentity, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`event: ready\ndata: ${JSON.stringify({ unread: store.countUnread(req.idHash) })}\n\n`);
    if (!listeners.has(req.idHash)) listeners.set(req.idHash, new Set());
    listeners.get(req.idHash).add(res);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
    req.on('close', () => {
      clearInterval(keep);
      const set = listeners.get(req.idHash);
      if (set) { set.delete(res); if (!set.size) listeners.delete(req.idHash); }
    });
  });

  /* ── public pages (the shareable, Linktree-shaped URLs) ──────────────────── */
  async function servePage(ref, res) {
    const { row, byCode } = resolve(ref);
    if (!row || row.status !== 'published' || (!byCode && !row.discoverable)) {
      return res.status(404).type('html').send('<!doctype html><meta charset=utf-8><title>Not found</title><body style="font:16px system-ui;padding:40px">No such card.</body>');
    }
    store.bumpViews(row.identity);
    const shareUrl = row.handle ? `${PUBLIC_URL}/@${row.handle}` : `${PUBLIC_URL}/c/${row.code}`;
    let qrSvg = '';
    try { qrSvg = await QRCode.toString(shareUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }); } catch { /* page still renders */ }
    const agentJsonUrl = `${PUBLIC_URL}/v1/card/${row.handle || row.code}/agent.json`;
    res.type('html').send(cardPage(publicCard(row), { shareUrl, qrSvg, agentJsonUrl }));
  }
  app.get('/@:handle', (req, res) => servePage(req.params.handle, res));
  app.get('/c/:code', (req, res) => servePage(req.params.code, res));

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset=utf-8><title>agent-card</title>
<body style="font:16px/1.6 system-ui;max-width:640px;margin:48px auto;padding:0 20px;background:#0b0b12;color:#f3f3f7">
<h1>agent-card</h1>
<p>A public card for your agent. Publish it, get discovered, accept a connection, and let incoming messages wake a local agent session.</p>
<p><a style="color:#8b7bff" href="/v1/directory">Browse the directory →</a></p>
<p style="color:#9a9aad">Get a card: <code>npx agent-card init</code></p></body>`);
  });

  app.locals.push = push;
  return { app, store, push, PUBLIC_URL };
}

module.exports = { createServer, publicCard, ownerCard, sanitizeCard };

/* Run directly: node src/server.js */
if (require.main === module) {
  const { app, PUBLIC_URL } = createServer();
  const port = process.env.PORT || 8787;
  app.listen(port, () => console.log(`agent-card directory on ${PUBLIC_URL} (port ${port})`));
}
