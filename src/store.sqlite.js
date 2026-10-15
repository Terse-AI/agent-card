'use strict';
/**
 * store.sqlite.js — a SQLite backing with the exact same method surface as
 * store.js, so the server does not know or care which one it got. Uses Node's
 * built-in `node:sqlite` (no native build step). Select it by pointing the
 * server at a .db path:  AGENT_CARD_SQLITE=data.db npm start
 *
 * Array/object card fields (skills, stack, links, read_by) are JSON text
 * columns, parsed on the way out so a row looks identical to a JSON-store row.
 * The signing columns (public_key, signature, signed_at) are here from the start
 * so signed cards need no migration.
 */
const { DatabaseSync } = require('node:sqlite');

const DDL = `
CREATE TABLE IF NOT EXISTS profiles (
  identity     TEXT PRIMARY KEY,
  handle       TEXT UNIQUE,
  code         TEXT UNIQUE,
  display_name TEXT,
  headline     TEXT,
  bio          TEXT,
  location     TEXT,
  skills       TEXT,
  stack        TEXT,
  links        TEXT,
  agent_kind   TEXT,
  agent_name   TEXT,
  avatar       TEXT,
  status       TEXT DEFAULT 'draft',
  auto_accept  INTEGER DEFAULT 0,
  discoverable INTEGER DEFAULT 1,
  drafted_by   TEXT,
  views        INTEGER DEFAULT 0,
  public_key   TEXT,
  signature    TEXT,
  signed_at    TEXT,
  created_at   TEXT,
  updated_at   TEXT,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS connections (
  id          TEXT PRIMARY KEY,
  a_identity  TEXT,
  b_identity  TEXT,
  status      TEXT,
  opened_via  TEXT,
  note        TEXT,
  created_at  TEXT,
  responded_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  connection_id TEXT,
  from_identity TEXT,
  from_kind     TEXT,
  body          TEXT,
  created_at    TEXT,
  read_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_conn_a ON connections(a_identity);
CREATE INDEX IF NOT EXISTS idx_conn_b ON connections(b_identity);
CREATE INDEX IF NOT EXISTS idx_msg_conn ON messages(connection_id);
`;

const PROFILE_COLS = [
  'identity', 'handle', 'code', 'display_name', 'headline', 'bio', 'location',
  'skills', 'stack', 'links', 'agent_kind', 'agent_name', 'avatar', 'status',
  'auto_accept', 'discoverable', 'drafted_by', 'views', 'public_key', 'signature',
  'signed_at', 'created_at', 'updated_at', 'published_at',
];
const JSON_FIELDS = new Set(['skills', 'stack', 'links']);
const BOOL_FIELDS = new Set(['auto_accept', 'discoverable']);

function createSqliteStore(file) {
  const dataFile = file || process.env.AGENT_CARD_SQLITE || 'data.db';
  const db = new DatabaseSync(dataFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
  db.exec(DDL);

  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

  function rowToProfile(r) {
    if (!r) return null;
    const p = { ...r };
    for (const f of JSON_FIELDS) p[f] = parse(r[f], []);
    for (const f of BOOL_FIELDS) p[f] = !!r[f];
    return p;
  }

  // Full-row write used by both insert and the merge path. Values serialised here.
  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO profiles (${PROFILE_COLS.join(',')})
     VALUES (${PROFILE_COLS.map(() => '?').join(',')})`);
  function writeProfile(p) {
    const vals = PROFILE_COLS.map((c) => {
      let v = p[c];
      if (JSON_FIELDS.has(c)) v = JSON.stringify(Array.isArray(v) ? v : (v || []));
      else if (BOOL_FIELDS.has(c)) v = v ? 1 : 0;
      else if (v === undefined) v = null;
      return v;
    });
    upsertStmt.run(...vals);
  }

  const getByIdentity = db.prepare('SELECT * FROM profiles WHERE identity = ?');
  const getByHandle = db.prepare('SELECT * FROM profiles WHERE handle = ?');
  const getByCode = db.prepare('SELECT * FROM profiles WHERE code = ?');

  const getConnStmt = db.prepare('SELECT * FROM connections WHERE id = ?');
  const insConnStmt = db.prepare(
    `INSERT INTO connections (id,a_identity,b_identity,status,opened_via,note,created_at,responded_at)
     VALUES (?,?,?,?,?,?,?,?)`);
  const insMsgStmt = db.prepare(
    `INSERT INTO messages (id,connection_id,from_identity,from_kind,body,created_at,read_by)
     VALUES (?,?,?,?,?,?,?)`);

  const sinceOk = (iso, ms) => new Date(iso).getTime() >= Date.now() - ms;

  return {
    /* ── profiles ─────────────────────────────────────────────────────────── */
    getProfile: (identity) => rowToProfile(getByIdentity.get(identity)),
    getProfileByHandle: (handle) => rowToProfile(getByHandle.get(handle)),
    getProfileByCode: (code) => rowToProfile(getByCode.get(code)),

    upsertProfile(identity, patch) {
      const prev = rowToProfile(getByIdentity.get(identity)) || {
        identity, created_at: patch.created_at, code: null, handle: null,
        status: 'draft', auto_accept: false, discoverable: true, views: 0,
      };
      const merged = { ...prev, ...patch, identity };
      writeProfile(merged);
      return rowToProfile(getByIdentity.get(identity));
    },
    publishProfile(identity, { code, handle, published_at, updated_at }) {
      const p = rowToProfile(getByIdentity.get(identity));
      if (!p) return null;
      if (code) p.code = code;
      if (handle) p.handle = handle;
      p.status = 'published';
      p.published_at = p.published_at || published_at;
      p.updated_at = updated_at;
      writeProfile(p);
      return rowToProfile(getByIdentity.get(identity));
    },
    unpublishProfile(identity, updated_at) {
      const p = rowToProfile(getByIdentity.get(identity));
      if (!p) return null;
      p.status = 'draft'; p.updated_at = updated_at; writeProfile(p);
      return rowToProfile(getByIdentity.get(identity));
    },
    rotateCode(identity, code, updated_at) {
      const p = rowToProfile(getByIdentity.get(identity));
      if (!p) return null;
      p.code = code; p.updated_at = updated_at; writeProfile(p);
      return rowToProfile(getByIdentity.get(identity));
    },
    deleteProfile(identity) {
      const conns = db.prepare('SELECT id FROM connections WHERE a_identity = ? OR b_identity = ?').all(identity, identity);
      const delMsg = db.prepare('DELETE FROM messages WHERE connection_id = ?');
      for (const c of conns) delMsg.run(c.id);
      db.prepare('DELETE FROM connections WHERE a_identity = ? OR b_identity = ?').run(identity, identity);
      db.prepare('DELETE FROM profiles WHERE identity = ?').run(identity);
    },
    bumpViews(identity) {
      db.prepare('UPDATE profiles SET views = COALESCE(views,0) + 1 WHERE identity = ?').run(identity);
    },
    listProfiles({ q, limit, offset }) {
      const all = db.prepare("SELECT * FROM profiles WHERE status = 'published' AND discoverable = 1 ORDER BY published_at DESC").all();
      let rows = all.map(rowToProfile);
      if (q) {
        const n = q.toLowerCase();
        rows = rows.filter((p) => [p.display_name, p.handle, p.headline, p.bio, ...(p.skills || []), ...(p.stack || [])]
          .filter(Boolean).join(' ').toLowerCase().includes(n));
      }
      return { total: rows.length, rows: rows.slice(offset, offset + limit) };
    },

    /* ── connections ──────────────────────────────────────────────────────── */
    findConnection(x, y) {
      return getConnStmt && db.prepare(
        `SELECT * FROM connections WHERE (a_identity = ? AND b_identity = ?) OR (a_identity = ? AND b_identity = ?) LIMIT 1`
      ).get(x, y, y, x) || null;
    },
    getConnection: (id) => getConnStmt.get(id) || null,
    insertConnection(edge) {
      insConnStmt.run(edge.id, edge.a_identity, edge.b_identity, edge.status, edge.opened_via, edge.note, edge.created_at, edge.responded_at);
      return edge;
    },
    listConnections(me) {
      const rows = db.prepare('SELECT * FROM connections WHERE a_identity = ? OR b_identity = ?').all(me, me);
      return rows.sort((a, b) => {
        const score = (c) => (c.status === 'pending' && c.b_identity === me ? 0 : 1);
        return score(a) - score(b) || String(b.created_at).localeCompare(String(a.created_at));
      });
    },
    respondConnection(id, me, status, respondedAt) {
      const r = db.prepare("UPDATE connections SET status = ?, responded_at = ? WHERE id = ? AND b_identity = ? AND status = 'pending'")
        .run(status, respondedAt, id, me);
      return r.changes > 0;
    },
    deleteConnection(id, me) {
      const r = db.prepare('DELETE FROM connections WHERE id = ? AND (a_identity = ? OR b_identity = ?)').run(id, me, me);
      return r.changes > 0;
    },
    countConnectionsSince(me, ms) {
      const cutoff = new Date(Date.now() - ms).toISOString();
      return db.prepare('SELECT COUNT(*) c FROM connections WHERE a_identity = ? AND created_at >= ?').get(me, cutoff).c;
    },

    /* ── messages ─────────────────────────────────────────────────────────── */
    insertMessage(msg) {
      insMsgStmt.run(msg.id, msg.connection_id, msg.from_identity, msg.from_kind, msg.body, msg.created_at, JSON.stringify([msg.from_identity]));
      return msg;
    },
    listMessages(connectionId) {
      return db.prepare('SELECT * FROM messages WHERE connection_id = ? ORDER BY created_at ASC').all(connectionId);
    },
    markRead(connectionId, me) {
      const rows = db.prepare('SELECT id, read_by FROM messages WHERE connection_id = ?').all(connectionId);
      const upd = db.prepare('UPDATE messages SET read_by = ? WHERE id = ?');
      for (const r of rows) {
        const rb = parse(r.read_by, []);
        if (!rb.includes(me)) { rb.push(me); upd.run(JSON.stringify(rb), r.id); }
      }
    },
    countUnread(me) {
      const conns = db.prepare("SELECT id FROM connections WHERE (a_identity = ? OR b_identity = ?) AND status = 'accepted'").all(me, me);
      const ids = new Set(conns.map((c) => c.id));
      if (!ids.size) return 0;
      const rows = db.prepare('SELECT connection_id, read_by FROM messages').all();
      return rows.filter((m) => ids.has(m.connection_id) && !parse(m.read_by, []).includes(me)).length;
    },
    countMessagesSince(me, ms) {
      const cutoff = new Date(Date.now() - ms).toISOString();
      return db.prepare('SELECT COUNT(*) c FROM messages WHERE from_identity = ? AND created_at >= ?').get(me, cutoff).c;
    },

    flush() { /* durable on each write */ },
    _file: dataFile,
    _backend: 'sqlite',
  };
}

module.exports = { createSqliteStore };
