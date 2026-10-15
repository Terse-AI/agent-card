// End-to-end smoke test. Runs the full suite against BOTH storage backends
// (JSON file and built-in SQLite), covering draft → publish → discover →
// connect → accept → PUSHed message, plus signed cards, federation, the web app
// route and the well-known path.
//
//   node test/smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const C = createRequire(import.meta.url)(join(root, 'src/canonical.js'));

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.error('  ✗', label); } };

function openStream(base, secret) {
  const events = []; const ctl = new AbortController();
  (async () => {
    const res = await fetch(`${base}/v1/inbox/stream`, { headers: { 'x-agent-identity': secret, accept: 'text/event-stream' }, signal: ctl.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); if (block.startsWith(':')) continue;
          let event = 'message'; const data = [];
          for (const line of block.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trim()); }
          if (data.length) { try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch { /* skip */ } } } }
    } catch { /* aborted */ }
  })();
  return { events, close: () => ctl.abort() };
}
const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

async function runSuite(backend) {
  console.log(`\n=== backend: ${backend} ===`);
  const PORT = backend === 'sqlite' ? 8801 : 8800;
  const BASE = `http://127.0.0.1:${PORT}`;
  const dir = mkdtempSync(join(tmpdir(), `agent-card-${backend}-`));
  const env = { ...process.env, PORT: String(PORT), PUBLIC_URL: BASE };
  if (backend === 'sqlite') env.AGENT_CARD_SQLITE = join(dir, 'data.db');
  else env.DATA_FILE = join(dir, 'data.json');

  const srv = spawn(process.execPath, [join(root, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const headers = (s) => ({ 'content-type': 'application/json', 'x-agent-identity': s });
  const call = async (secret, method, route, body) => {
    const res = await fetch(BASE + route, { method, headers: headers(secret), body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({})); return { status: res.status, json: j };
  };
  const waitHealthy = async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 50)); } return false; };

  try {
    ok(await waitHealthy(), 'server boots and answers /healthz');
    const A = 'sk_ada_' + Math.random().toString(36).slice(2);
    const B = 'sk_boris_' + Math.random().toString(36).slice(2);

    let r = await call(A, 'POST', '/v1/card/draft', { display_name: 'Ada', handle: 'ada_agent', headline: 'builds compilers', skills: ['rust', 'llvm'], links: [{ label: 'site', url: 'https://example.com' }] });
    ok(r.status === 200 && r.json.profile.status === 'draft', 'A drafts (lands as draft)');
    r = await call(A, 'POST', '/v1/card/publish');
    ok(r.status === 200 && /^agt_[a-z2-9]{20}$/.test(r.json.code), 'A publishes, code minted');

    await call(B, 'POST', '/v1/card/draft', { display_name: 'Boris', handle: 'boris', headline: 'trades options' });
    r = await call(B, 'POST', '/v1/card/publish');
    ok(r.status === 200, 'B publishes');

    const noCard = 'sk_nobody_' + Math.random().toString(36).slice(2);
    r = await call(noCard, 'POST', '/v1/connect', { handle: 'ada_agent' });
    ok(r.status === 403, 'connect refused for someone with no published card');

    r = await call(B, 'GET', '/v1/directory?q=compilers');
    ok(r.status === 200 && r.json.cards.some((c) => c.handle === 'ada_agent'), 'B finds A in the directory');

    const aStream = openStream(BASE, A);
    ok(await waitFor(() => aStream.events.some((e) => e.event === 'ready')), 'A inbox stream is ready');

    r = await call(B, 'POST', '/v1/connect', { handle: 'ada_agent', note: 'can we be friends?' });
    ok(r.status === 200 && r.json.connection.status === 'pending', 'B connect lands as pending');
    const connId = r.json.connection.id;
    ok(await waitFor(() => aStream.events.some((e) => e.event === 'connect_request')), 'A is PUSHED the connect_request');

    r = await call(B, 'POST', `/v1/connections/${connId}/messages`, { body: 'hi early' });
    ok(r.status === 403, 'message blocked on a pending channel');
    await call(A, 'POST', `/v1/connections/${connId}/respond`, { action: 'accept' });
    r = await call(B, 'POST', `/v1/connections/${connId}/messages`, { body: 'hello Ada!' });
    ok(r.status === 200, 'B sends on the open channel');
    ok(await waitFor(() => aStream.events.some((e) => e.event === 'message' && e.data.body === 'hello Ada!')), 'A is PUSHED the message (wake-up path)');

    r = await call(A, 'GET', `/v1/connections/${connId}/messages`);
    ok(r.json.messages.some((m) => m.body === 'hello Ada!' && !m.mine), 'A reads the message');
    ok((await call(A, 'GET', '/v1/card/me')).json.unread === 0, 'unread clears after read');

    // ── signed cards ──
    const kp = C.generateKeypair();
    const me = (await call(A, 'GET', '/v1/card/me')).json.profile;
    const signature = C.sign(me, kp.privateKeyPem);
    r = await call(A, 'POST', '/v1/card/signature', { public_key: kp.publicKeyPem, signature });
    ok(r.status === 200 && r.json.ok, 'A registers an Ed25519 signature');
    const vj = await (await fetch(`${BASE}/v1/card/ada_agent/verify`)).json();
    ok(vj.verified === true, 'verify endpoint confirms the signature');
    const aj = await (await fetch(`${BASE}/v1/card/ada_agent/agent.json`)).json();
    ok(aj.signatures?.[0]?.verified === true, 'agent.json carries a verified signature');
    ok(C.verify(aj.signatures[0].payload, aj.signatures[0].publicKey, aj.signatures[0].signature) === true, 'signature verifies OFFLINE from agent.json alone');
    ok(C.verify({ ...aj.signatures[0].payload, display_name: 'Mallory' }, aj.signatures[0].publicKey, aj.signatures[0].signature) === false, 'a tampered card fails verification');
    r = await call(A, 'GET', '/v1/card/me');
    ok(r.json.profile.signed === true, 'owner card shows signed=true');

    // ── federation: ingest a card signed in ANOTHER directory, verified here
    //    with no trust in its origin ──
    const fKp = C.generateKeypair();
    const foreign = {
      code: 'agt_' + Math.random().toString(36).slice(2, 10) + 'remotecrd', handle: 'ada_remote',
      display_name: 'Ada Remote', headline: 'signed in another directory', bio: null, location: null,
      skills: ['rust'], stack: [], links: [], agent_kind: 'claude-code', agent_name: null,
      published_at: new Date().toISOString(),
    };
    const fSig = C.sign(foreign, fKp.privateKeyPem);
    const fedBody = { card: foreign, public_key: fKp.publicKeyPem, signature: fSig };
    const fed = await (await fetch(`${BASE}/v1/federation/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fedBody) })).json();
    ok(fed.ok === true && fed.verified === true, 'federation ingest verifies a foreign signed card');
    ok((await call(B, 'GET', '/v1/directory?q=remote')).json.cards.some((c) => c.handle === 'ada_remote'), 'ingested foreign card is discoverable');
    const bad = await fetch(`${BASE}/v1/federation/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fedBody, card: { ...foreign, headline: 'forged' } }) });
    ok(bad.status === 400, 'federation ingest rejects a forged card');

    // ── web app + well-known ──
    const appRes = await fetch(`${BASE}/app`); const appHtml = await appRes.text();
    ok(appRes.ok && appHtml.includes('agent-card') && appHtml.includes('inbox'), '/app serves the inbox UI');
    ok((await fetch(`${BASE}/.well-known/agent-card.json`)).status === 404, '/.well-known 404s without PRIMARY_HANDLE');

    // ── public surfaces + rotate ──
    const page = await fetch(`${BASE}/@ada_agent`); const html = await page.text();
    ok(page.ok && html.includes('Ada') && html.includes('agt_'), 'public page renders with name + code');
    ok((await fetch(`${BASE}/v1/card/ada_agent/qr.svg`)).ok, 'QR endpoint returns an SVG');
    const old = (await call(A, 'GET', '/v1/card/me')).json.profile.code;
    await call(A, 'POST', '/v1/card/rotate-code');
    ok((await call(B, 'GET', `/v1/card/${old}`)).status === 404, 'rotated code no longer resolves');

    aStream.close();
  } finally {
    srv.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

(async () => {
  await runSuite('json');
  await runSuite('sqlite');
})().catch((e) => { console.error('threw:', e); fail++; })
  .finally(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
