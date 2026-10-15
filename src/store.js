'use strict';
/**
 * store.js — a tiny JSON-file store so the whole thing runs with `npm install`
 * and no native build. The method surface is deliberately query-shaped
 * (getProfileByCode, listConnections, countMessagesSince …) so a production
 * swap to SQLite/Postgres is a reimplementation of this one file, nothing else.
 *
 * Everything is kept in memory and flushed to disk on each mutation. Fine for a
 * single-process directory; not meant to outlive that.
 */
const fs = require('fs');
const path = require('path');

function createStore(file) {
  const dataFile = file || process.env.DATA_FILE || path.join(process.cwd(), 'data.json');

  let db = { profiles: {}, connections: [], messages: [] };
  try {
    if (fs.existsSync(dataFile)) db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch { /* start empty on a corrupt file rather than crash the directory */ }
  db.profiles = db.profiles || {};
  db.connections = db.connections || [];
  db.messages = db.messages || [];

  let saveTimer = null;
  function save() {
    // Debounce bursts (a publish touches several fields) but never lose the last.
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
      } catch (e) { console.error('[store] save failed:', e.message); }
    }, 10);
  }
  function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(db, null, 2)); } catch { /* best effort */ } }

  const sinceMs = (iso, ms) => new Date(iso).getTime() >= Date.now() - ms;

  return {
    /* ── profiles ─────────────────────────────────────────────────────────── */
    getProfile: (identity) => db.profiles[identity] || null,
    getProfileByHandle: (handle) =>
      Object.values(db.profiles).find((p) => p.handle === handle) || null,
    getProfileByCode: (code) =>
      Object.values(db.profiles).find((p) => p.code === code) || null,

    upsertProfile(identity, patch) {
      const prev = db.profiles[identity] || {
        identity, created_at: patch.created_at, code: null, handle: null,
        status: 'draft', auto_accept: false, discoverable: true, views: 0,
      };
      db.profiles[identity] = { ...prev, ...patch, identity, updated_at: patch.updated_at };
      save();
      return db.profiles[identity];
    },

    publishProfile(identity, { code, handle, published_at, updated_at }) {
      const p = db.profiles[identity];
      if (!p) return null;
      if (code) p.code = code;
      if (handle) p.handle = handle;
      p.status = 'published';
      p.published_at = p.published_at || published_at;
      p.updated_at = updated_at;
      save();
      return p;
    },
    unpublishProfile(identity, updated_at) {
      const p = db.profiles[identity];
      if (!p) return null;
      p.status = 'draft'; p.updated_at = updated_at; save(); return p;
    },
    rotateCode(identity, code, updated_at) {
      const p = db.profiles[identity];
      if (!p) return null;
      p.code = code; p.updated_at = updated_at; save(); return p;
    },
    deleteProfile(identity) {
      delete db.profiles[identity];
      db.connections = db.connections.filter((c) => c.a_identity !== identity && c.b_identity !== identity);
      const gone = new Set(db.connections.map((c) => c.id));
      db.messages = db.messages.filter((m) => gone.has(m.connection_id));
      save();
    },
    bumpViews(identity) {
      const p = db.profiles[identity];
      if (p) { p.views = (p.views || 0) + 1; save(); }
    },

    listProfiles({ q, limit, offset }) {
      let rows = Object.values(db.profiles).filter((p) => p.status === 'published' && p.discoverable);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((p) =>
          [p.display_name, p.handle, p.headline, p.bio, ...(p.skills || []), ...(p.stack || [])]
            .filter(Boolean).join(' ').toLowerCase().includes(needle));
      }
      rows.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
      return { total: rows.length, rows: rows.slice(offset, offset + limit) };
    },

    /* ── connections ──────────────────────────────────────────────────────── */
    findConnection(x, y) {
      return db.connections.find((c) =>
        (c.a_identity === x && c.b_identity === y) ||
        (c.a_identity === y && c.b_identity === x)) || null;
    },
    getConnection: (id) => db.connections.find((c) => c.id === id) || null,
    insertConnection(edge) { db.connections.push(edge); save(); return edge; },
    listConnections(me) {
      const rows = db.connections.filter((c) => c.a_identity === me || c.b_identity === me);
      // Pending-incoming first: those are the ones asking for an answer.
      return rows.sort((a, b) => {
        const score = (c) => (c.status === 'pending' && c.b_identity === me ? 0 : 1);
        return score(a) - score(b) || String(b.created_at).localeCompare(String(a.created_at));
      });
    },
    respondConnection(id, me, status, respondedAt) {
      const c = db.connections.find((e) => e.id === id && e.b_identity === me && e.status === 'pending');
      if (!c) return false;
      c.status = status; c.responded_at = respondedAt; save(); return true;
    },
    deleteConnection(id, me) {
      const before = db.connections.length;
      db.connections = db.connections.filter((c) => !(c.id === id && (c.a_identity === me || c.b_identity === me)));
      const removed = db.connections.length !== before;
      if (removed) save();
      return removed;
    },
    countConnectionsSince(me, ms) {
      return db.connections.filter((c) => c.a_identity === me && sinceMs(c.created_at, ms)).length;
    },

    /* ── messages ─────────────────────────────────────────────────────────── */
    insertMessage(msg) { db.messages.push({ ...msg, read_by: [msg.from_identity] }); save(); return msg; },
    listMessages(connectionId) {
      return db.messages.filter((m) => m.connection_id === connectionId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
    markRead(connectionId, me) {
      let touched = false;
      for (const m of db.messages) {
        if (m.connection_id === connectionId && !m.read_by.includes(me)) { m.read_by.push(me); touched = true; }
      }
      if (touched) save();
    },
    countUnread(me) {
      const mine = new Set(db.connections
        .filter((c) => (c.a_identity === me || c.b_identity === me) && c.status === 'accepted')
        .map((c) => c.id));
      return db.messages.filter((m) => mine.has(m.connection_id) && !m.read_by.includes(me)).length;
    },
    countMessagesSince(me, ms) {
      return db.messages.filter((m) => m.from_identity === me && sinceMs(m.created_at, ms)).length;
    },

    flush,
    _file: dataFile,
  };
}

module.exports = { createStore };
