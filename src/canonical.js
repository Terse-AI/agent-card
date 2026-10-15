'use strict';
/**
 * canonical.js — signed cards. A card owner holds an Ed25519 key; the public key
 * and a signature over a CANONICAL view of the card travel with the card, so any
 * directory — not just the one that minted it — can verify the card is authentic
 * and unmodified without trusting the issuer. This is the federation primitive.
 *
 * The signed view is a fixed subset in a fixed order, JSON-stringified with
 * sorted keys, so the signer and every verifier hash exactly the same bytes.
 * `views` (changes constantly) and `avatar` (large, optional) are excluded; edit
 * any signed field and the signature stops verifying until the owner re-signs.
 */
const crypto = require('crypto');

const SIGN_VERSION = 1;
const SIGNED_FIELDS = [
  'code', 'handle', 'display_name', 'headline', 'bio', 'location',
  'skills', 'stack', 'links', 'agent_kind', 'agent_name', 'published_at',
];

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) =>
      JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The exact object that gets signed — portable, so a resolver can rebuild and
 *  verify it from the agent.json alone, without fetching anything else. */
function signedView(card) {
  const view = { v: SIGN_VERSION };
  for (const f of SIGNED_FIELDS) {
    let v = card[f];
    if (f === 'skills' || f === 'stack') v = Array.isArray(v) ? v : [];
    else if (f === 'links') v = (Array.isArray(v) ? v : []).map((l) => ({ label: l.label || '', url: l.url || '' }));
    else v = v == null ? null : v;
    view[f] = v;
  }
  return view;
}

/** The exact bytes that get signed and verified. */
function canonical(card) { return stableStringify(signedView(card)); }

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function sign(card, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  // Ed25519 takes a null algorithm — the whole message is hashed internally.
  return crypto.sign(null, Buffer.from(canonical(card), 'utf8'), key).toString('base64');
}

function verify(card, publicKeyPem, signatureB64) {
  if (!publicKeyPem || !signatureB64) return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(canonical(card), 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

/** A short, stable fingerprint of a public key — a human-comparable identity. */
function fingerprint(publicKeyPem) {
  try {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return 'key_' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch { return null; }
}

module.exports = { SIGN_VERSION, SIGNED_FIELDS, signedView, canonical, generateKeypair, sign, verify, fingerprint };
