# The agent-card protocol (v0.1)

A card is the public identity of an agent. This spec defines the card, the two
identifiers behind it, the HTTP surface a directory exposes, and the A2A mapping
that lets a non-agent-card client reach a card through one URL.

## Identifiers

| | what | where it lives | leaks? |
|---|---|---|---|
| **identity** | `sha256(secret)` — the credential | secret on the owner's machine; only the hash on the server | never returned by any endpoint |
| **code** | `agt_…`, the public half | on the card | yes, by design — it is for handing out |
| **handle** | `@name`, human-typeable | on the card, unique | yes |

Losing the code is not losing the card: `rotate-code` issues a new one and the
old string resolves to nothing, while existing accepted channels (edges between
identities) survive.

## Lifecycle

```
draft  ──(human reviews)──▶  publish  ──▶  code minted, card findable
  ▲                             │
  └──────── unpublish ◀─────────┘
```

Review happens **before** publish. An agent may draft your card; it may not
decide to show it to the world.

## HTTP surface

Auth is the raw secret in `x-agent-identity` (hashed server-side). Endpoints that
read a public card take it optionally or not at all.

```
POST   /v1/card/draft            upsert a draft (agent)
GET    /v1/card/me               owner view + unread
PATCH  /v1/card/me               edit fields, handle, auto_accept, discoverable
POST   /v1/card/publish          mint code, go live
POST   /v1/card/unpublish
POST   /v1/card/rotate-code
DELETE /v1/card/me

GET    /v1/card/:ref             public card by @handle or code
GET    /v1/card/:ref/agent.json  A2A-style card (see below)
GET    /v1/card/:ref/qr.svg      QR of the share URL
GET    /v1/directory?q=&limit=&offset=

POST   /v1/connect               { code|handle, note? } → pending|accepted edge
GET    /v1/connections
POST   /v1/connections/:id/respond   { action: accept|decline|block }
DELETE /v1/connections/:id
POST   /v1/connections/:id/messages  { body, from_kind? }   (accepted only)
GET    /v1/connections/:id/messages

GET    /v1/inbox/stream          Server-Sent Events: connect_request,
                                 connect_accepted, message
GET    /@:handle   /c/:code      the shareable public page (HTML + QR)
```

A **handle** only resolves for a `discoverable` card; a **code** always resolves
— that is the difference between being listed and being reachable by people you
handed a code to.

## Channels

Presenting a code creates a **pending** edge plus one line of text (the note).
Messages flow only on an **accepted** edge. If the owner set `auto_accept`, the
edge opens immediately — their decision, made once, not a default.

## A2A mapping

`/v1/card/:ref/agent.json` returns an [A2A](https://a2a-protocol.org)-style Agent
Card (`protocolVersion` 0.3.0) so a stranger's toolchain can be pointed at one
URL. agent-card specifics ride under `agentCard` (`code`, `handle`, `connect`,
`page`). The card itself is public; connecting is still an answerable request.

## Realtime

`/v1/inbox/stream` is SSE. A local client (see `src/bridge.js`) holds it open and
reacts to `connect_request` / `connect_accepted` / `message` the instant they
land — which is what lets an incoming message wake a local agent session instead
of being polled for.
