# Ayni Agent

A **Verifiable Service** that holds conversations, keeps memory and performs trust-bound actions for
its operator, as specified by [ayni-spec v3](https://github.com/2060-io/ayni-spec/tree/main/v3/ayni-agent).
People reach it from the wallet app over DIDComm and from a [Ayni UI](https://github.com/2060-io/ayni-ui)
in the browser over the [Ayni AG-UI Profile](https://github.com/2060-io/ayni-spec/tree/main/v3/ayni-agui-profile);
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
| `packages/agui-profile/` | `@2060.io/ayni-agui-profile`: types, constants and JSON schemas of the wire contract, consumed by the UI | PROF-* |
| `schemas/`, `docs/agent-pack.md`, `agent-packs/` | the agent-pack schema 3.0, its documentation, the example and development packs | CORE-PACK |
| `dev/` | the local VS Agent on the Verana devnet (`dev/vs-agent`), the agent's own stack (`dev/compose`), tools | PLAT-DEPLOY-002 |
| `agent-packs/welcome/` | "Welcome to Ayni", the onboarding agent deployed with the UI (in the image at `/app/agent-packs/welcome`) | |
| `charts/ayni-agent/` | Helm chart `ayni-agent-chart` (`namespace` value, ingress, inline or ConfigMap agent pack) | PLAT-DEPLOY-001 |

[DECISIONS.md](DECISIONS.md) records the implementation decisions taken while building, and what
is deferred.

## Quick start

Requirements: Node 24, pnpm (through corepack), Docker.

```bash
pnpm install
docker compose -f dev/compose/docker-compose.yml up -d      # pgvector, redis, minio
cp .env.example .env                                         # fill DATABASE_URL etc. (defaults match the compose stack)
pnpm dev                                                     # the dev pack: stub model, no keys
curl http://localhost:3020/.well-known/ayni-agent.json
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
| `/.well-known/ayni-agent.json` | agent descriptor (profile section 2) |
| `/agui/v3/sessions…` | the AG-UI profile (sessions, binding, stream, runs, history, attachments) |
| `/vs-agent/events` | webhook of the DIDComm agent (`EVENTS_WEBHOOK_URL`) |
| `/webrtc/call-event`, `/vision/…` | face-match callbacks (WebRTC server, vision service) |
| `/media/{token}` | short-lived media links for the wallet |
| `/.well-known/agent.json`, `/a2a` | A2A (when `channels.a2a.enabled`) |
| `/health/live`, `/health/ready`, `/stats`, `/integrity/anchors` | operations |

## Docker

```bash
docker build -t io2060/ayni-agent:local .
docker run --rm -p 3010:3010 --env-file .env io2060/ayni-agent:local
```

## Continuous integration and releases

- **CI** (`.github/workflows/ci.yml`) runs on every pull request to `main` and on pushes: the shared
  2060 pipeline (install, build, format, types, unit tests, Helm chart lint, conventional PR title)
  plus a Docker image build without push.
- **CD** (`.github/workflows/cd.yml`) runs on pushes to `main`, `release/**` and `v[0-9]*` branches
  once the repository variable `CD_ENABLED` is `true`:
  - every push with releasable commits publishes a **dev prerelease** `vX.Y.Z-dev` (semantic-release),
    the image `io2060/ayni-agent:vX.Y.Z-dev` with the floating `dev`, `vX-dev`, `vX.Y-dev` tags from
    `main`, and the Helm chart `oci://docker.io/io2060/ayni-agent-chart` at the same version;
  - **release-please** keeps a Release PR open on `main`; merging it creates the stable tag `vX.Y.Z`,
    the GitHub release with `CHANGELOG.md`, the image tags `vX.Y.Z`, `vX.Y`, `vX` and `latest`, the
    chart at `vX.Y.Z`, and a Discord announcement.
- Versions follow conventional commits: `fix:` bumps the patch, `feat:` the minor, `feat!:` the
  major (minor while below 1.0).
- Secrets and variables expected by CD: `DOCKER_HUB_LOGIN`, `DOCKER_HUB_PWD`,
  `DISCORD_UPDATES_WEBHOOK_URL` (secrets) and `CD_ENABLED` (variable).

## Dependencies on other components

- VS Agent 2.x with `POST /v2/didcomm/out-of-band` and the `didcomm.out-of-band.handshake-reused`
  event ([verana-labs/vs-agent#800](https://github.com/verana-labs/vs-agent/pull/800)).
- wallet app presenting an ECS-UserAgent credential (ayni-spec `CC-APP-001`); until then run
  with `userAgentGate: optional`.
