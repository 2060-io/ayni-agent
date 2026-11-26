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
| `src/core/` | the channel-agnostic core: types, principals and role rules, sessions and binding, spaces (`spaces.ts`: templates, membership, handover), capability router, challenges, orchestrator (the LLM turn), prompt add-on, interaction, the agent facade | CORE, IDENT, CHAN-ROUTE, CHAN-BIND, INTX, SPACE, D1 to D47 |
| `src/memory/` | per-entry crypto, the scope query-builder, the memory service (entries, window, recall, working memory, erasure), RAG | MEM, PRIV |
| `src/store/` | the persistence interface, PostgreSQL (+pgvector) and in-memory stores, memory schema migrations | TOOL-HTTP-004, PRIV-SCOPE-005, CORE-VER |
| `src/policy/` | tool tiers (RBAC) and the approval workflow | RBAC, INTX-APPR, PRIV-ELEV |
| `src/tools/` | tool registry, HTTP tools, bundled tools, MCP client | TOOL |
| `src/features/` | features and providers: the agent's copy of the feature profiles Files 1.0 and Calendar 1.0 (`profiles.ts`, pinned to the documents vendored in `spec/`), what each provider declares, the marks of references, a call of a profile's tool and its result (`service.ts`) | TOOL-FEAT, D120 to D124 |
| `src/llm/` | chat model adapters (OpenAI, generic chat-completions, Anthropic, Ollama, Azure, Bedrock, Vertex, stub) and embeddings | LLM |
| `src/media/` | object store, speech-to-text, vision, image generation, the media service | MEDIA, MEM-ATT |
| `src/channels/didcomm/` | VS Agent client, identity flow, DIDComm adapter, webhook events, face-match and WebRTC callbacks | CHAN-ADP, IDENT-RES, INTX-AUTH |
| `src/channels/agui/` | the AG-UI profile: descriptor, sessions, binding, stream, runs, history, attachments, spaces, memories | CHAN-ADP-004, PROF-* |
| `src/channels/a2a/` | agent card and JSON-RPC endpoint | CHAN-ADP-001, CHAN-BIND-007 |
| `src/integrity/`, `src/platform/` | Verana anchoring, statistics, retention | INTEG, PLAT |
| `packages/agui-profile/` | `@ayni.org/ayni-agui-profile`: types, constants and JSON schemas of the wire contract, consumed by the UI | PROF-* |
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

## Evaluations of the model

What only a real model shows runs on demand against the model of a deployment, never in CI: it needs the provider's
key, it costs tokens, and a model does not answer the same way twice (ayni-spec reference implementation profile,
"Evaluations of the model").

**Requests without a call** (TOOL-CALL-017, D114): after a call that asked an approval or a confirmation was decided,
does the model call the tool for a new action, or does it only say that it asked, as the Dev Agent did on devnet on
2026-11-21? Run it with the configuration of the deployment whose model it checks, the variables the container takes:

```bash
AGENT_PACK_PATH=/path/to/agent-pack \
LLM_PROVIDER=openai-compatible LLM_MODEL=kimi-k3 LLM_BASE_URL=https://api.moonshot.ai/v1 LLM_API_KEY=… \
pnpm eval:approval-claims                     # 10 runs of each case; --runs N, --case <id> (repeatable)
pnpm eval:approval-claims -- --replay scripts/eval/fixtures/devnet-2026-11-21-215226.json   # must FAIL
```

- `AGENT_PACK_PATH` is a directory holding `agent-pack.yaml`, or the file. The Dev Agent's is the `agentPack` value of
  `charts/devnet/dev-ayni-agent.yaml` in `2060-io/ayni-deploy`: `yq '.agentPack' charts/devnet/dev-ayni-agent.yaml >
  /tmp/dev-pack/agent-pack.yaml`. A placeholder of the pack the environment does not set (an OAuth client, a badge
  schema) gets a stand-in, which nothing the evaluation runs reaches, and a missing user directory an empty one; the
  `LLM_*` placeholders are never filled in.
- Each run builds the agent on the in-memory store with that pack. Every tool server is replaced by a local stub, the
  space's account by values that fit its fields, and the phone by a stub that decides as the case says: nothing is
  posted and nobody is asked. The conversation before the person's last message is played through the agent's own code
  with a scripted model, so its history is what the agent writes; the last turn goes to the deployment's provider and
  model through the agent's adapter.
- The cases: `devnet-2026-11-21` (a member's post asked, approved on the owner's phone and run; then a new post),
  `after-a-claim` (the same, then a reply that says approval was requested with no call; then the same post again),
  `confirmation` (the owner's own post, his own confirmation on his phone, INTX-APPR-023, confirmed and run; then
  another one) and
  `after-a-refusal` (a post the owner rejected; then "Ask again for the same post"). A run passes only when the turn
  calls the posting tool, whatever its reply says.
- The posting tool is the first tool of a space whose rule is `approval`, `x.post_tweet` for the Dev Agent; `--post
  <source>.<tool>` names another. An MCP stub lists each offered tool with a `text` argument and those its bindings pin;
  `--schemas <file>` gives the input schemas the real server lists, as `{ "<source>.<tool>": { …schema } }`.
- The report gives, per case, the provider, the model, the version of the add-on, the runs and the failures, each with
  the text of its reply; `--out report.md` writes it with its JSON beside it. The command exits with 1 when a run fails.
- Run it before a release that changes the add-on, the tools' answers of the call rules (TOOL-CALL-015) or the model a
  deployment uses, and attach its report to that release's pull request. `--replay` checks the evaluation itself: fed
  the reply of the Dev Agent of 21:52:26 (reconstructed in the fixture: the exact words were not kept), it must fail.

## Configuration

Behavior lives in the agent-pack (`AGENT_PACK_PATH`, see `docs/agent-pack.md`); deployment values and
secrets are environment variables, listed in `.env.example` and in the specification's reference
implementation profile. Any pack value may be overridden with `${VAR}` placeholders.

Each person's own tool accounts (`account.kind: personal`, ayni-spec D104 to D110) are connected by the person in Your
accounts, through OAuth as MCP defines it or by typing the fields of a personal token; see "Each person's own accounts"
in `docs/agent-pack.md` for the keys and the Relaticle and GitHub examples. They need `PUBLIC_BASE_URL` reachable from
the internet at `/tools/oauth/callback` and `/tools/oauth/client-metadata.json`, `APP_LINK_BASE` (where the browser goes
after a sign-in), the secrets of a pre-registered client as `${VAR}` placeholders (`TOOLS_GITHUB_CLIENT_ID`,
`TOOLS_GITHUB_CLIENT_SECRET` on devnet), and optionally `TOOL_OAUTH_ATTEMPT_SECONDS` (600), how long a sign-in may take.

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
| `/tools/oauth/callback`, `/tools/oauth/client-metadata.json` | each person's own accounts: the callback of a sign-in, the agent's client ID metadata document (public, routed by the ingress when the pack declares a source of `account.kind: personal` with `oauth`) |
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
    the GitHub release with `CHANGELOG.md`, the image tags `vX.Y.Z`, `vX.Y`, `vX` and `latest`, and
    the chart at `vX.Y.Z`.
- Versions follow conventional commits: `fix:` bumps the patch, `feat:` the minor, `feat!:` the
  major (minor while below 1.0).
- Secrets and variables expected by CD: `DOCKER_HUB_LOGIN`, `DOCKER_HUB_PWD` (secrets) and `CD_ENABLED`
  (variable).

## Dependencies on other components

- VS Agent 2.x with `POST /v2/didcomm/invitations` (standalone invitation records,
  [verana-labs/vs-agent#804](https://github.com/verana-labs/vs-agent/pull/804)), which the agent mints its binding
  invitations with: a new connection names the record as `invitationId`, and the
  `didcomm.out-of-band.handshake-reused` event ([verana-labs/vs-agent#800](https://github.com/verana-labs/vs-agent/pull/800))
  names it as `outOfBandId` (ayni-spec CHAN-BIND-017). An invitation of `POST /v2/didcomm/out-of-band` would not do:
  since #804 a connection carries no `outOfBandId`. The VS Agent also needs a
  `discovery.json` that queries peers' features: the disclosure arrives as a
  `didcomm.connections.state-updated` event in state `updated` whose `metadata` lists the disclosed
  protocols. A wallet that discloses `https://didcomm.org/ayni-flow/1.0` is served in **flow mode**
  (ayni-spec D54): no welcome text, menus, receipts, reactions or chat on its connection; everything
  it needs goes through its own sessions and flows. Any other wallet is served as before. The devnet
  image `io2060/vs-agent-ayni` (ayni-deploy) ships both.
- In flow mode the agent uses the plugin's routes (`/v2/didcomm/ayni-flow/flows`, `/v2/didcomm/confirm`,
  `/v2/didcomm/link-session`) and its events (`didcomm.ayni-flow.state-changed`, `didcomm.confirm.state-changed`,
  `didcomm.link-session.state-changed`): identity at connect is an `identify-ua` flow then an `authenticate` flow, the
  device challenge a `confirm` flow, browser binding a `link-session` flow (ayni-spec D55, INTX-FLOW, INTX-AUTH-009,
  CHAN-BIND-009). Every flow opened from a conversation is one entry (`sourceType: flow`) shown as the `ayni.flow`
  card and updated in place at its close; `presentation-request` and `credential-offer` take `parentThreadId`
  (VS Agent branch `feat/ayni-plugin-loader`). Face-match calls and NFC reads still go out as v3 messages until
  the OWF `calls` and `mrtd` modules carry a parent thread (CC-EXT-002).
- The Ayni app binds its own sessions through the session grant (`didcomm.session-grant.state-changed` →
  `POST /v2/didcomm/session-grant/:threadId/grant`, then `POST /agui/v3/sessions` with `grant`): single use,
  `GRANT_EXPIRY_SECONDS` (default and maximum 60), issued only on a connection whose peer is a resolved Principal
  (ayni-spec D56, CHAN-BIND-014). `client.platform` is `web`, `ios` or `android` and `client.description` is what the
  phone shows for the session (CHAN-BIND-015). The request names its `endpoint`, `ag-ui` when absent; one that is
  not open to the peer is refused with `not-eligible`.
- The authentication runs on the phone only, over `authenticate/1.0` (ayni-spec D125 to D131, flow profile §6.14):
  the agent opens an `authenticate` flow (one at a time on a connection: the plugin answers `409` to a second) and
  sends the request (`POST /v2/didcomm/authenticate`: the purpose, the methods and the accepted combinations of
  `identity.authentication`), hears the person's `choice` and `answer`s (`didcomm.authenticate.state-changed`), runs the
  methods of the combination chosen with `POST .../{threadId}/step` and `.../step-result` (a credential by
  `presentation-request`, a document by `mrtd/request-emrtd`, a face match by a call, each under the flow id), and
  closes the flow `completed` or answers it with a problem report (`issuer-not-accepted`, `not-valid`, `incomplete`,
  `step-failed`, `step-expired`, `no-match`, `different-identities`, `another-identity`). An authenticator app or a
  passkey is enrolled in an `enrol` flow the phone opens (`didcomm.authenticate.enrol-state-changed`, `POST
  /v2/didcomm/authenticate-enrol/{threadId}/challenge`) and removed by an `unenrol`
  (`didcomm.authenticate.unenrol-received`). A person who declines the consent of a face match chooses another combination in
  the same flow (the step ends `consent-declined`). It needs `@ayni.org/vs-agent-plugin-ayni-flow` 0.3.1. A wallet that takes
  no flows is asked a `credential` method that is a combination by itself, as a presentation request, and nothing else.
  A tool's step-up (`stepUp.authentication`, ayni-spec D127) asks the same flow with purpose `step-up` before the call:
  the one set of methods the tool names, the action named in its `text`, the session the call came from as origin, and
  the Principal of the connection as the identity every method must find or confirm; the session gets
  `ayni.capability.routed` of kind `authentication`, the model the outcome only. A badge from the user directory is
  issued apart from the authentication (D130), from the entry it identified, offered automatically or on demand.
- The agent tells each peer where it stands with it (`peer-status/1.0`, `POST /v2/didcomm/peer-status`; ayni-spec
  D71, IDENT-STAT): the rule by which it identifies the peer, following from `identity.authentication` (`none`
  with no combination, `optional` with visitors let in, `required` without), its methods and accepted combinations,
  to an identified person the types they may enrol and those they enrolled, whether the peer is identified, and
  what is open to it on the connection (`ag-ui` for a person). It is sent once the Principal is resolved, before
  the credential is asked when it is required, and again when a field changes; a peer the agent refuses is told why
  (`untrusted`, `identity-refused`, `not-admitted`) before the connection ends. A wallet waits for this message
  before it asks for a session grant. It needs the plugin `@ayni.org/vs-agent-plugin-ayni-flow` with the peer-status
  module: the agent asks its VS Agent at start, declares `features.peerStatus` in its descriptor only when the VS
  Agent has it (PROF-DESC-007), and serves wallets as before when it does not.
- Wake-ups: a reply or an agent-initiated run that lands while no screen of the Principal shows the conversation
  sends one `notify/1.0` on a flow-capable phone (`POST /v2/didcomm/notify`; conversation id, title, preview,
  collapse key), never for a flow; the agent holds no push token (ayni-spec D57, INTX-NOTIFY-001/002). An approval
  rule with `attested: true` reaches a flow-capable approver as an `authorize` flow and the decision's attestation
  method is recorded on the approval (D58, INTX-APPR-011).
- App links: with `APP_LINK_BASE` (or `channels.agui.appLinkBase`, e.g. `https://app.dev.ayni.org/app/`) the platform
  rules let the model send people to the app's destinations (`explore`, `scan`, `wallet`, `settings/backup`...) with
  links on the network's app-link domain and nothing else (AG-UI profile 3.1 §10, PROF-LINK-001). The Welcome pack
  uses them in its menu and prompt (CC-WEL-003). A holder's `reissue` request after a restore is answered
  `unknown-reference` (this agent issues no credential; an issuing agent plugs its policy into
  `DidcommEvents.onReissueStateChanged`), and revocation notifications come with issuance (INTX-FLOW-006/007).
- Email (ayni-spec D89, PLAT-MAIL-001): the code of an `email` method of the authentication and the invitations of people
  of other organizations go through the SMTP server of the deployment, named by the variables of the 2060.io website:
  `MAIL_HOST`, `MAIL_PORT` (587, STARTTLS when the server offers it; 465 or `MAIL_ENCRYPTION=ssl`: TLS from the start),
  `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`. Without `MAIL_HOST` and `MAIL_FROM_ADDRESS`
  the agent refuses to start with an `email` method, and the invitations are disabled, which it says at start. `pnpm test:mail` runs the email tests against a throwaway Mailpit in Docker.
- The Verana Graph (`VERANA_GRAPH_URL`, `https://graph.devnet.verana.network` on devnet): its search
  (`POST /v4/graph/search`, the `Did` surface, operators of kind `Organization`) finds the organizations a list space
  invites people from (`GET {sessions}/organizations`, ayni-spec D90, PROF-DIR-002); an invitation is refused for an
  organization it does not hold trusted. The same graph the UIs search.
- Revocation of the badges issued from the user directory (decision 61): the VS Agent's
  `POST /v2/anoncreds/revoke-credential` and the flow plugin's `POST /v2/didcomm/revocation-notification`.
- wallet app presenting an ECS-UserAgent credential (ayni-spec `CC-APP-001`); until then run
  with `userAgentGate: optional`.
