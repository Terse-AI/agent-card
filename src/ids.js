'use strict';
/**
 * ids.js — the two identifiers every card has, and nothing else.
 *
 *   identity  the CREDENTIAL. The raw install secret lives only on the owner's
 *             machine; the server stores and compares sha256(secret) and never
 *             sees or returns the raw value. Holding it IS being the owner.
 *   code      the PUBLIC half, `agt_…`. Safe in a README, a QR, a tweet. All it
 *             can do is ask to open a channel — which a human still answers
 *             unless they turned auto-accept on. Rotating it is one field.
 */
const crypto = require('crypto');

const sha = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/** A fresh install secret for a brand-new card. Shown once, stored by the owner. */
function mintSecret() {
  return 'sk_' + crypto.randomBytes(24).toString('hex');
}

/* Unambiguous alphabet: no 0/O/1/I/l. A code is read aloud, photographed and
   retyped — every look-alike pair is a support ticket. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function mintCode() {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'agt_' + out;
}

/** Handles that read as the service itself. */
const RESERVED_HANDLES = new Set([
  'agent', 'agents', 'card', 'cards', 'admin', 'root', 'support', 'help',
  'api', 'www', 'official', 'staff', 'system', 'security', 'billing', 'team',
  'terse', 'terseai',
]);

/** A handle is what people type at each other. Normalised once, here. */
function normaliseHandle(v) {
  const h = (typeof v === 'string' ? v : '').trim().toLowerCase().replace(/^@/, '');
  if (!h) return { handle: null };
  if (!/^[a-z0-9_]{3,24}$/.test(h)) {
    return { error: 'A handle is 3–24 characters: a–z, 0–9 and _' };
  }
  if (RESERVED_HANDLES.has(h)) return { error: `@${h} is reserved` };
  return { handle: h };
}

/** Derive a stable handle from a display name when the owner gave none. */
function handleFromName(name, taken) {
  const base = (name || 'agent').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 16) || 'agent';
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? base : `${base}_${crypto.randomBytes(2).toString('hex')}`;
    if (cand.length >= 3 && !RESERVED_HANDLES.has(cand) && !taken(cand)) return cand;
  }
  return null;
}

module.exports = {
  sha, uuid, nowIso, mintSecret, mintCode, normaliseHandle, handleFromName,
  RESERVED_HANDLES,
};
