// End-to-end smoke test: boot the directory, run two cards through
// draft → publish → discover → connect → accept → message, and assert the
// message is PUSHED to the recipient's SSE stream (the wake-up path).
//
//   node test/smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'agent-card-'));

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.error('  ✗', label); } };

const headers = (secret) => ({ 'content-type': 'application/json', 'x-agent-identity': secret });
async function call(secret, method, route, body) {
  const res = await fetch(BASE + route, { method, headers: headers(secret), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// A collector for one identity's SSE stream.
function openStream(secret) {
  const events = [];
  const ctl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/v1/inbox/stream`, { headers: { 'x-agent-identity': secret, accept: 'text/event-stream' }, signal: ctl.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          let event = 'message'; const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (data.length) { try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch { /* skip */ } }
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => ctl.abort() };
}
const waitFor = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

const srv = spawn(process.execPath, [join(root, 'src/server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_FILE: join(dataDir, 'data.json'), PUBLIC_URL: BASE },
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function run() {
  ok(await waitHealthy(), 'server boots and answers /healthz');

  const A = 'sk_test_ada_' + Math.random().toString(36).slice(2);
  const B = 'sk_test_boris_' + Math.random().toString(36).slice(2);

  // Draft + publish both.
  let r = await call(A, 'POST', '/v1/card/draft', { display_name: 'Ada', handle: 'ada_agent', headline: 'builds compilers', skills: ['rust', 'llvm'], links: [{ label: 'site', url: 'https://example.com' }] });
  ok(r.status === 200 && r.json.profile.status === 'draft', 'A drafts (lands as draft)');
  r = await call(A, 'POST', '/v1/card/publish');
  ok(r.status === 200 && /^agt_[a-z2-9]{20}$/.test(r.json.code), 'A publishes, code minted');
  ok(r.json.share_url === `${BASE}/@ada_agent`, 'A gets a share URL');

  r = await call(B, 'POST', '/v1/card/draft', { display_name: 'Boris', handle: 'boris', headline: 'trades options' });
  ok(r.status === 200, 'B drafts');
  r = await call(B, 'POST', '/v1/card/publish');
  ok(r.status === 200, 'B publishes');

  // Connect without a card is refused; B has one, so it works.
  const noCard = 'sk_nobody_' + Math.random().toString(36).slice(2);
  r = await call(noCard, 'POST', '/v1/connect', { handle: 'ada_agent' });
  ok(r.status === 403, 'connect refused for someone with no published card');

  // Discovery.
  r = await call(B, 'GET', '/v1/directory?q=compilers');
  ok(r.status === 200 && r.json.cards.some((c) => c.handle === 'ada_agent'), 'B finds A in the directory');

  // A listens; B asks to connect.
  const aStream = openStream(A);
  ok(await waitFor(() => aStream.events.some((e) => e.event === 'ready')), 'A inbox stream is ready');

  r = await call(B, 'POST', '/v1/connect', { handle: 'ada_agent', note: 'can we be friends?' });
  ok(r.status === 200 && r.json.connection.status === 'pending' && r.json.opened === false, 'B connect lands as pending (A has no auto-accept)');
  const connId = r.json.connection.id;

  ok(await waitFor(() => aStream.events.some((e) => e.event === 'connect_request')), 'A is PUSHED the connect_request');
  const reqEvt = aStream.events.find((e) => e.event === 'connect_request');
  ok(reqEvt.data.connection.note === 'can we be friends?', 'request carries the one line of note');

  // Messages blocked before accept.
  r = await call(B, 'POST', `/v1/connections/${connId}/messages`, { body: 'hi early' });
  ok(r.status === 403, 'message blocked on a pending channel');

  // A accepts; B sends; A is pushed the message.
  r = await call(A, 'POST', `/v1/connections/${connId}/respond`, { action: 'accept' });
  ok(r.status === 200 && r.json.connection.status === 'accepted', 'A accepts the channel');

  r = await call(B, 'POST', `/v1/connections/${connId}/messages`, { body: 'hello Ada!' });
  ok(r.status === 200, 'B sends a message on the open channel');
  ok(await waitFor(() => aStream.events.some((e) => e.event === 'message' && e.data.body === 'hello Ada!')), 'A is PUSHED the message (wake-up path)');

  // A reads; unread clears.
  r = await call(A, 'GET', `/v1/connections/${connId}/messages`);
  ok(r.status === 200 && r.json.messages.some((m) => m.body === 'hello Ada!' && !m.mine), 'A reads the message');
  r = await call(A, 'GET', '/v1/card/me');
  ok(r.json.unread === 0, 'unread clears after read');

  // Public surfaces.
  const page = await fetch(`${BASE}/@ada_agent`); const html = await page.text();
  ok(page.ok && html.includes('Ada') && html.includes('agt_'), 'public page renders with name + connect code');
  const qr = await fetch(`${BASE}/v1/card/ada_agent/qr.svg`); const svg = await qr.text();
  ok(qr.ok && svg.includes('<svg'), 'QR endpoint returns an SVG');
  const aj = await (await fetch(`${BASE}/v1/card/ada_agent/agent.json`)).json();
  ok(aj.protocolVersion === '0.3.0' && aj.agentCard.handle === 'ada_agent', 'agent.json is A2A-shaped');

  // Rotating the code invalidates the old one.
  const old = (await call(A, 'GET', '/v1/card/me')).json.profile.code;
  await call(A, 'POST', '/v1/card/rotate-code');
  r = await call(B, 'GET', `/v1/card/${old}`);
  ok(r.status === 404, 'rotated code no longer resolves');

  aStream.close();
}

run()
  .catch((e) => { console.error('threw:', e); fail++; })
  .finally(() => {
    srv.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
