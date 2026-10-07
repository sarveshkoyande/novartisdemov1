# Novartis Accelerate — Campaign Studio

Standalone copy of Accelerate with the redesigned NORA Campaign Studio UI
(Dashboard → New Campaign → Existing Brand → upload/notes → review →
Campaign Memory planning → SA validation → Flow Planner). It has no
dependency on any other folder.

- Client UI: `client/src/pages` (React), planning logic in `client/src/studio`.
- Server routes for the studio: `server/studio-routes.js` (campaign
  persistence in the `StudioCampaign` table, file/notes extraction and NORA
  field mapping via Claude; the client falls back to local deterministic
  mapping when no model key is set).
- Dev ports: server **4310**, client **5180** (so it can run beside the
  original on 4300/5173). In production the server uses `PORT`.

---


A pharma campaign requirement-gathering platform: a React client (form UI,
chat, Flow Design/Visio Builder) backed by an Express + Prisma/SQLite server
that also drives a real LLM (Claude) for the chat's form-filling agent.

Two apps, one server process serves both in production:

- **`client/`** — React 19 + Vite + TypeScript. The real app UI. Talks to
  the server over `/api/*`.
- **`server/`** — Express + Prisma (SQLite). REST + SSE routes, and the
  agent tool-use loop (`runAgentTurn` in `server.js`) that drives the chat.
  In production it also serves `client/dist` as static files plus a SPA
  fallback (see the bottom of `server.js`) — one process, one port.

`public/index.html` is the original single-file prototype this was ported
from. It's kept as reference but is no longer served or maintained — don't
edit it expecting it to affect the running app.

## Setup

The database and the generated Prisma client are both gitignored (`*.db`,
`server/generated/`), so a fresh clone has neither — both steps below are
required, not optional, or the server starts against an empty/missing
database and the app loads blank.

```bash
# 1. Server
cd server
npm install
npx prisma generate          # builds server/generated/prisma from schema.prisma
npx prisma migrate deploy    # creates dev.db and applies every migration
npm run seed                 # loads prisma/demo-data.json (idempotent — safe to re-run)
cp .env.example .env
# edit .env and paste in your OWN Foundry key (never one shared in chat/commit)
npm start                    # http://localhost:4310
```

```bash
# 2. Client (separate terminal)
cd client
npm install
npm run dev                  # http://localhost:5180 (proxies /api to :4310 — see vite.config.ts)
```

Open **http://localhost:5173** during development — that's the client with
hot reload, proxying API calls to the server on :4300. The server on :4300
alone only serves the API plus whatever's already in `client/dist` (nothing,
until you `npm run build` in `client/`).

### Re-seeding / resetting demo data

`npm run seed` (`server/prisma/seed.js`) is idempotent per table — it only
fills tables that are empty, so it never overwrites real edits. To rebuild
`demo-data.json` from your own local database after making schema/fixture
changes: `node prisma/export-demo-data.js`.

## Deployment

`render.yaml` (repo root, kept in sync with the copy in `accelerate-app/`)
is the authoritative build/start command for Render — it builds the client,
then installs the server, generates the Prisma client, applies migrations,
and seeds, all in one `buildCommand`. Copy that command if you're setting up
CI or a different host; don't hand-roll a new one.

Render's SQLite disk is ephemeral on the free plan — see the comments in
`render.yaml` for the persistent-disk / Postgres options if you need data to
survive a deploy.

## Provider

Claude on Microsoft Foundry, via `@anthropic-ai/foundry-sdk`. The SDK builds
`https://{ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com/anthropic/` and
sends `ANTHROPIC_FOUNDRY_API_KEY` as the `x-api-key` header. Model is set by
`CLAUDE_DEPLOYMENT` (the Foundry deployment name, e.g. `claude-opus-4-8`).

Entra ID auth (`DefaultAzureCredential`) is also supported by the SDK via an
`azureADTokenProvider` — not wired up here; this project uses key auth.

## TLS on managed laptops

`npm start`/`npm run dev` (server) both run `node --use-system-ca`. Corporate
TLS interception re-signs traffic with a root CA that lives in the Windows
trust store, which Node otherwise ignores — without the flag every model
call fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, surfaced as a generic
`fetch failed`. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0` instead; it
disables certificate validation process-wide.

## Files

- `server/server.js` — Express app. Two SSE agent routes, `POST
  /api/agent-fill` (form filling) and `POST /api/visio-agent` (diagram
  editing), both driven by `runAgentTurn()` — one shared Anthropic tool-use
  loop. Tools execute server-side; the model never mutates state directly.
  Serves `client/dist` statically in production, with a SPA fallback for
  client-side routes.
- `server/.env.example` — copy to `.env`; `ANTHROPIC_FOUNDRY_API_KEY` and
  `ANTHROPIC_FOUNDRY_RESOURCE` are both required.
- `server/prisma/` — `schema.prisma`, migrations, `seed.js` /
  `export-demo-data.js`, and the one-off `migrate-*.js` data-fix scripts
  (each documents, in its own header comment, the specific bug it fixed).
- `client/src/` — the real app: `pages/` (route-level screens),
  `components/`, `stores/` (Zustand — chat, session, Visio Builder state),
  `hooks/useAgentFill.ts` (the SSE client for the chat agent).
- `public/index.html` — the original prototype. Not served; kept for
  reference only.

## Conversation history

The Messages API is stateless, so the server returns the full `messages`
array in the SSE `history` event and the client resends it next turn. The
client treats it as an opaque blob, so the format is the server's to change.

## Security notes

- Never put a real API key in client-side code — anyone viewing source gets
  it. The server is the only thing that ever sees `ANTHROPIC_FOUNDRY_API_KEY`.
- `.env` is gitignored. `.env.example` has no real value in it.
- If a key was ever pasted in chat or committed, treat it as compromised —
  rotate it in the provider's console immediately.
