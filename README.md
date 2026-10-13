# Hologram Agent

A **Verifiable Service** that holds conversations, keeps memory and performs trust-bound actions for
its operator, as specified by [hologram-spec v3](https://github.com/2060-io/hologram-spec/tree/main/v3/hologram-agent).
People reach it from the Hologram App over DIDComm and from a [Hologram UI](https://github.com/2060-io/hologram-ui)
in the browser over the [Hologram AG-UI Profile](https://github.com/2060-io/hologram-spec/tree/main/v3/hologram-agui-profile);
other agents reach it over A2A. Identity comes from Verifiable Trust v4 credentials, never from accounts.

## Layout

| Path | What it holds | Spec areas |
|------|---------------|------------|
| `src/config/` | environment (`env.ts`), agent-pack types and loader (`pack.ts`: placeholders, coercion, schema, cross-field rules) | CORE-PACK, PRIV-RETN-006 |
| `src/core/` | the channel-agnostic core: types, principals and role rules, sessions and binding, capability router, challenges, orchestrator (the LLM turn), prompt add-on, interaction, the agent facade | CORE, IDENT, CHAN-ROUTE, CHAN-BIND, INTX, D1 to D47 |
| `src/memory/` | per-entry crypto, the scope query-builder, the memory service (entries, window, recall, working memory, erasure), RAG | MEM, PRIV |
| `src/store/` | the persistence interface, PostgreSQL (+pgvector) and in-memory stores, memory schema migrations | TOOL-HTTP-004, PRIV-SCOPE-005, CORE-VER |
| `src/policy/` | tool tiers (RBAC) and the approval workflow | RBAC, INTX-APPR, PRIV-ELEV |
| `src/tools/` | tool registry, HTTP tools, bundled tools, MCP client | TOOL |
| `src/llm/` | chat model adapters (OpenAI, generic chat-completions, Anthropic, Ollama, Azure, Bedrock, Vertex, stub) and embeddings | LLM |
| `src/media/` | object store, speech-to-text, vision, image generation, the media service | MEDIA, MEM-ATT |
| `src/channels/didcomm/` | VS Agent client, identity flow, DIDComm adapter, webhook events, face-match and WebRTC callbacks | CHAN-ADP, IDENT-RES, INTX-AUTH |
| `src/channels/agui/` | the AG-UI profile: descriptor, sessions, binding, stream, runs, history, attachments | CHAN-ADP-004, PROF-* |
| `src/channels/a2a/` | agent card and JSON-RPC endpoint | CHAN-ADP-001, CHAN-BIND-007 |
| `src/integrity/`, `src/platform/` | Verana anchoring, statistics, retention | INTEG, PLAT |
| `packages/agui-profile/` | `@2060.io/hologram-agui-profile`: types, constants and JSON schemas of the wire contract, consumed by the UI | PROF-* |
| `schemas/`, `docs/agent-pack.md`, `agent-packs/` | the agent-pack schema 3.0, its documentation, the example and development packs | CORE-PACK |
| `dev/` | the local VS Agent on the Verana devnet (`dev/vs-agent`), the agent's own stack (`dev/compose`), tools | PLAT-DEPLOY-002 |
| `charts/hologram-agent/` | Helm chart | PLAT-DEPLOY-001 |

[DECISIONS.md](DECISIONS.md) records the implementation decisions taken while building, and what
is deferred.

## Quick start

Requirements: Node 24, pnpm (through corepack), Docker.

```bash
pnpm install
docker compose -f dev/compose/docker-compose.yml up -d      # pgvector, redis, minio
cp .env.example .env                                         # fill DATABASE_URL etc. (defaults match the compose stack)
pnpm dev                                                     # the dev pack: stub model, no keys
curl http://localhost:3020/.well-known/hologram-agent.json
```

Binding and every trust-bound event need a DIDComm agent (VS Agent) registered on a Verana network;
`dev/vs-agent/README.md` describes the development instance on the devnet. The agent starts without
it and logs that binding is unavailable until the Admin API answers.

Tests run on the in-memory store with the stub model: `pnpm test`.

## Configuration

Behavior lives in the agent-pack (`AGENT_PACK_PATH`, see `docs/agent-pack.md`); deployment values and
secrets are environment variables, listed in `.env.example` and in the specification's reference
implementation profile. Any pack value may be overridden with `${VAR}` placeholders.

Development switches, refused in production (`NODE_ENV=production`):

- `DEV_ALLOW_UNIDENTIFIED_PRINCIPALS=true`: a DIDComm peer that presents no ECS-Badge becomes a
  Principal without backing identity (relation `unrecognized`, `public` visibility only). Needed on
  networks that have no badge issuer yet.
- `llm.provider: stub`, `embeddings.provider: stub`, `model: stub` for speech-to-text and vision:
  offline stand-ins.

## Endpoints

| Path | Purpose |
|------|---------|
| `/.well-known/hologram-agent.json` | agent descriptor (profile section 2) |
| `/agui/v3/sessions…` | the AG-UI profile (sessions, binding, stream, runs, history, attachments) |
| `/vs-agent/events` | webhook of the DIDComm agent (`EVENTS_WEBHOOK_URL`) |
| `/webrtc/call-event`, `/vision/…` | face-match callbacks (WebRTC server, vision service) |
| `/media/{token}` | short-lived media links for the wallet |
| `/.well-known/agent.json`, `/a2a` | A2A (when `channels.a2a.enabled`) |
| `/health/live`, `/health/ready`, `/stats`, `/integrity/anchors` | operations |

## Dependencies on other components

- VS Agent 2.x with `POST /v2/didcomm/out-of-band` and the `didcomm.out-of-band.handshake-reused`
  event ([verana-labs/vs-agent#800](https://github.com/verana-labs/vs-agent/pull/800)).
- Hologram App presenting an ECS-UserAgent credential (hologram-spec `CC-APP-001`); until then run
  with `userAgentGate: optional`.
