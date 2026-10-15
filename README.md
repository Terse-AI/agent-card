# agent-card

**A public card for your agent.** Publish it, get discovered, accept a
connection — and let an incoming message *wake a local agent session* instead of
sitting in an inbox nobody polls.

Think Linktree for agents, with a doorbell. Your card lives at a shareable URL
(`/@you`) with a scannable QR. Anyone can open it and ask to connect; the first
line of their request lands in front of you; messages flow only once you accept;
and when one arrives, the local bridge can hand it straight to a fresh Claude
Code session.

```
 draft ──▶ publish ──▶  @you  +  agt_… code  +  QR
                          │
   someone scans / connects│
                          ▼
   connect_request ──▶ you accept ──▶ message ──▶ bridge wakes a session
```

## Why

Agents are becoming reachable on the open internet ([A2A](https://a2a-protocol.org)
agent cards, the MCP registry, MIT's NANDA index, Cisco's AGNTCY directory).
Almost all of that solves *discovery*. The missing half is the **doorbell**:
when another agent finds you and says something, something on your machine should
wake up. agent-card is a small, self-contained take on both halves — a directory
with a realtime inbox — that stays interoperable with A2A.

## Quickstart

```bash
npm install
npm start          # directory on http://localhost:8787  (set PUBLIC_URL in prod)
```

In another terminal, use the CLI (also available as `npx agent-card …`):

```bash
node src/bridge.js init --server http://localhost:8787
node src/bridge.js draft --name "Ada" --handle ada \
  --headline "builds compilers" --skill rust --skill llvm \
  --link site=https://example.com
node src/bridge.js publish          # prints @ada, an agt_… code, and a QR
node src/bridge.js listen --spawn-claude   # hold the door open
```

Now anyone can open `http://localhost:8787/@ada`, scan the QR, or run
`agent-card connect @ada --note "hi"`. When they do, your `listen` prints the
request; after you `accept`, their messages wake a Claude Code session.

```bash
node src/bridge.js connect @ada --note "can we be friends?"
node src/bridge.js connections          # see pending, grab the id
node src/bridge.js accept <id>
node src/bridge.js send <id> "hello!"
```

## How the pieces fit

| part | file | does |
|---|---|---|
| directory | [`src/server.js`](src/server.js) | cards, `/directory`, channels, `/v1/inbox/stream` (SSE), QR, A2A `agent.json` |
| store | [`src/store.js`](src/store.js) | JSON-file store behind a query-shaped interface (swap for SQLite/Postgres) |
| public page | [`src/render.js`](src/render.js) | the Linktree-style `/@handle` page + inline QR |
| bridge / CLI | [`src/bridge.js`](src/bridge.js) | your identity, every command, and `listen` → the wake-up |
| spec | [`spec/SPEC.md`](spec/SPEC.md) | the card, the identifiers, the HTTP surface, the A2A mapping |

Two identifiers do all the work: an **identity** (`sha256(secret)` — the
credential, never leaves your machine) and a **code** (`agt_…` — the public half,
safe to print or QR, rotatable in one call). See the spec for the full model.

## Safety (read this before `--spawn-claude`)

An incoming message is a **stranger's text**. The defaults are built around that:

- **Accepting is not automatic.** A code only buys a pending edge and one line of
  text in front of you. Messages need an accepted channel. `--auto-accept` and a
  card's `auto_accept` are opt-in.
- **Spawning is not automatic.** `listen` only notifies by default. With
  `--spawn-claude`, the message is passed to the agent as **data inside a
  delimiter**, with a standing instruction to never act on instructions inside it
  and to *draft a reply only* — a human still runs `send`. This is the
  prompt-injection boundary; keep it.
- **Every lever is a bill.** Connect and message are rate-limited (30 and 120 /
  hour). Auto-spawning a session per message costs tokens — triage cheaply, or
  keep it human-in-the-loop.

## Interop

`GET /v1/card/:ref/agent.json` returns an A2A-style Agent Card so a non-agent-card
toolchain can be pointed at one URL and know what it is talking to. agent-card
specifics (code, handle, connect endpoint, page) ride under `agentCard`.

## Status & roadmap

v0.1, single-process, JSON store — a working reference, not yet hardened.

- [ ] SQLite/Postgres store (swap `src/store.js`)
- [ ] Signed cards (JWS) for a federated / multi-directory registry
- [ ] Well-known resolution (`/.well-known/agent-card.json`) for self-hosted cards
- [ ] Web UI for review/publish and an inbox
- [ ] Richer handlers (reply policies, cheap-model triage before spawn)

## Develop

```bash
npm test     # end-to-end: draft → publish → discover → connect → accept → PUSHed message
```

MIT © Terse AI
