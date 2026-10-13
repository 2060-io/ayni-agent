# Agent pack, schema 3.0

The agent pack is the single configuration bundle of a Hologram Agent: everything about behavior and
policy lives in one `agent-pack.yaml`, validated at startup against
[`schemas/agent-pack.schema.json`](../schemas/agent-pack.schema.json). The agent refuses to start
without a valid pack (spec CORE-PACK-001, CORE-PACK-003). Deployment values and secrets stay in the
environment (see the container variables in the specification's reference implementation profile);
the pack refers to them with placeholders.

A complete example: [`agent-packs/example/agent-pack.yaml`](../agent-packs/example/agent-pack.yaml).

## Loading

1. `AGENT_PACK_PATH` points to a directory containing `agent-pack.yaml` (or `.yml`, `.json`).
2. After parsing, every string value is scanned for `${VAR}` and `${VAR:-default}`; placeholders are
   replaced from the environment (CORE-PACK-002). A `${VAR}` with no value and no default is an
   error. A default may not contain `}`; inside a YAML flow list or map, quote the value
   (`["${ORIGINS}"]`). A comma-separated value becomes a list where the schema expects one.
3. After substitution, values are coerced where the schema expects a number or a boolean
   (`"1800"` → `1800`, `"true"` → `true`) and the document is validated against the schema.
   Validation errors name the field and stop the start.
4. Cross-field rules (below) are checked after schema validation.

Relative paths (`rag.sources[].path`, `tools.http[].parameters` files if any) resolve from the pack
directory.

## Top-level sections

| Section | Required | What it holds | Spec |
|---------|----------|---------------|------|
| `schemaVersion` | yes | `"3.x"`; the loader refuses another major | CORE-PACK-004 |
| `metadata` | yes | id, display name, description, tags | |
| `identity` | yes | home backing identity, user-agent gate, recognized backing identities, roles, role rules, per-actor overrides | D30, D34, D37, D38 |
| `language` | yes | the one agent language | D21 |
| `persona` | yes | system prompt, greeting, contextual menu | D46, CORE-PROMPT |
| `llm` | yes | model provider and model | LLM-PROV |
| `embeddings` | yes | embeddings provider and model | LLM-EMB |
| `memory` | | context window, working memory, summarization, retrieval | D9, D10, D24, D25 |
| `rag` | | corpus sources with visibility | D42, MEM-RAG |
| `tools` | | declarative HTTP tools, bundled tools, their access policy | TOOL-HTTP, TOOL-ACCESS |
| `mcp` | | MCP servers and per-server tool access | TOOL-MCP, D41 |
| `purposes` | | governance list for elevation | D14, D15 |
| `approvals` | | default approval and elevation policy | INTX-APPR |
| `actions` | | per-tool auth challenge and credential freshness | D7, D28, INTX-AUTH |
| `sessions` | | idle timeout, binding expiry, liveness TTL, sibling sessions | D6, D7, D36 |
| `channels` | | AG-UI and A2A adapters | D1, D2, CHAN-* |
| `privacy` | yes | processing activities with lawful basis and retention, erasure | D18, PRIV-RETN |
| `media` | | speech-to-text, vision, image generation, face verification | D45, INTX-AUTH-007 |
| `integrity` | | anchoring cadence | D26, INTEG-ANCHOR |
| `statistics` | | statistics sink | PLAT-STATS |
| `features` | | feature gates | CORE-PROMPT-002 |

## identity

```yaml
identity:
  homeBackingIdentity: did:webvh:...          # the operator's Org or Persona
  userAgentGate: required                     # required | optional
  recognizedBackingIdentities:
    - { identity: did:webvh:..., relation: home }
    - { identity: did:webvh:..., relation: partner, label: Baltic Forwarding }
  roles:
    finance-manager: { canApprove: true, crossSession: own-backing-identity }
    auditor:         { auditor: true }
  roleRules:
    - when: { relation: home, claims: { department: [Finance, Treasury] } }
      roles: [employee, finance]
    - when: { relation: home }
      roles: [employee]
    - when: { relation: partner }
      roles: [partner]
  perActorOverrides:
    - { actor: <badge subject or service id>, roles: [auditor] }
```

- **Role assignment is rules over verified facts, never rosters** (D34). A rule's `when` matches on the
  Principal's `relation` to this agent (`home`, `partner`, `unrecognized`), its `connectionType`,
  whether the ECS-UserAgent credential was presented (`userAgentVerified`), and verified `claims`
  (ECS-Badge facts such as `department` or `title`; ECS-Service attributes for services). A list value
  matches any of its entries. The first matching rule wins. No match: the Principal is authenticated
  with no roles, no backing identity and `public` visibility only.
- `perActorOverrides` apply before the rules, for named actors.
- `roles` declares every role used anywhere in the pack. `crossSession` sets the role's cross-session
  memory scope (RBAC-XSESS): `own-sessions` (default), `own-backing-identity`, `all`. `canApprove`
  marks roles that may appear in `approvers`. `auditor` grants read-only access to the whole
  persistent store outside LLM retrieval.
- `userAgentGate: optional` lets wallets that do not present an ECS-UserAgent credential connect; the
  Principal is then marked `userAgentVerified: false`, which `roleRules` may use.

## persona

- `systemPrompt` is the author's prompt. The platform appends its own system-prompt add-on (working
  memory rules, scoped retrieval, challenges, reaction policy, tools); the persona never overrides it.
- `greeting` is sent on first contact and on every new conversation; `{userName}` is replaced.
- `menu` items are the author's contextual menu. Platform items (sessions, approvals with badge) are
  added automatically. An item's `action` is `prompt` (sends a text as the user's turn), `tool` (calls
  a tool directly, subject to the same access tiers) or `url`. `visibleWhen` is `always`, `bound`
  (only to bound Principals) or `role` with a `roles` list.

## llm and embeddings

`provider` selects an adapter: native (`openai`, `anthropic`, `ollama`), the generic chat-completions
adapter (`openai-compatible`, for gateways such as OpenRouter or LiteLLM and any compatible endpoint,
`baseUrl` required) or a special-protocol adapter (`azure-openai`, `bedrock`, `vertex`, with
`provider_options` as the adapter documents). `apiKeyEnv` names the environment variable holding the
key; keys never appear in the pack. `multimodal: true` lets a capable model receive referenced media;
the agent never depends on it. Embeddings are configured independently and may use another provider.

## memory, rag

- `memory.contextWindowTokens` is the token budget of the active window (token-based, D25).
- `workingMemory` is the LLM-curated, principal-scoped note store; `summarization` compresses the
  window transiently; `retrieval` tunes the semantic index (`topK`, chunking, ambient descriptions).
- `rag.sources` are agent-level knowledge, chunked and embedded. Each source declares a `visibility`
  (`public` default, `organization-shared`, `partner-shared`) and is retrieved through the same scope
  predicate as memory (MEM-RAG-005). `url` sources may be refreshed on an interval.

## tools, mcp and access tiers

Tool credentials are held by the deployment and shared; the agent never accepts a credential from a
principal (TOOL-ACCESS-001). Every `(role, tool)` resolves to one tier:

| Tier | How it is configured | Behavior |
|------|----------------------|----------|
| ALLOW | tool listed in `toolAccess.roles[role]` (or `default: all`) | runs directly; the model sees the tool |
| APPROVAL | tool listed in `toolAccess.approval[]` and in the role's set | runs after per-use human approval |
| REQUESTABLE | tool listed in `toolAccess.elevation[]` and not in the role's set | hidden until an elevation grant is active |
| DENY | otherwise | never available |

`toolAccess` has the same shape for MCP servers (`mcp.servers[].toolAccess`) and for HTTP and bundled
tools (`tools.access`). `"*"` in a role's list allows every tool of that server. `approval[]` entries
name `tools`, `approvers` (declared roles with `canApprove`), optional `timeoutMinutes`, `policy`
(`count` or `percentage`, `vetoOnRefusal`) and `approverConnectionType`. `elevation[]` entries add
`purposes` (ids from the top-level `purposes`) and `grantTtlMinutes`. Defaults for all of them come
from `approvals`.

HTTP tools are declared with a JSON Schema for their parameters; `{param}` placeholders in `url` and
`bodyTemplate` are filled from the model's arguments. MCP servers connect lazily by default.

## purposes and approvals

`purposes` is the closed, governance-defined list a principal may declare when requesting an
out-of-role tool (D15). `permittedRoles` optionally restricts who may declare a purpose. The model
never declares a purpose and never approves. `approvals` holds the defaults: timeout, policy,
`selfApproval` (a requester who is also an eligible approver runs without a prompt) and the default
grant duration.

## actions

Per-tool policies keyed by tool name:

```yaml
actions:
  issue_refund:
    authChallenge: { type: face-match, onChannelUnavailable: fail, referenceImage: badge-photo }
    maxCredentialAge: 0
```

- `authChallenge.type`: `device` (a question-answer on the capability channel; the device requires
  local authentication to be used), `face-match` (a call joined by the face-verification service, the
  badge photo as reference), `document` (NFC read). `onChannelUnavailable` is `fail` (default) or
  `degrade`.
- `maxCredentialAge`: seconds of accepted staleness for the credential-liveness verdict before this
  tool runs; `0` forces a fresh check; absent means the session TTL `N`.

## sessions, channels

`sessions` sets the idle timeout, the binding window (invitation and code lifetime), the liveness TTL
`N` and whether sibling sessions may be opened from a bound token. `channels.agui` sets the UI origins
allowed by CORS, the wallet link template (an HTTPS app link with `{oob}`, never `didcomm://`) and the
upload limits published in the descriptor. DIDComm is always on.

## privacy

`processingActivities` enumerates the personal-data processing this agent performs and declares, for
each, an operator-asserted lawful basis and a retention policy (D18). Ids are fixed:
`conversation-memory`, `working-memory`, `rag-corpus`, `media-objects`, `credential-presentations`,
`approvals`, `statistics`. Histories are archived at expiry, never deleted, so the digest chain stays
verifiable; credential presentations and digest anchors are kept indefinitely. `erasureRequests`
enables crypto-erasure with its lineage cascade.

## media, integrity, statistics, features

- `media.speechToText` and `media.vision` turn voice notes and inbound images into text (D45);
  `vision.provider: llm` reuses a multimodal language model. `media.imageGeneration` lists providers;
  `media.faceVerification` points to the face-verification service and the WebRTC server.
- `integrity.anchoring` sets the batch cadence of Verana `store-digest` anchoring.
- `statistics` selects the ingestion sink.
- `features` gates capabilities; a disabled feature disappears from the system-prompt add-on and the
  descriptor.

## Cross-field rules (checked after schema validation)

1. `identity.homeBackingIdentity` appears in `recognizedBackingIdentities` with `relation: home`,
   and exactly one entry has `relation: home`.
2. Every role named in `roleRules`, `perActorOverrides`, `toolAccess.roles`, `approvers`,
   `purposes[].permittedRoles` and `persona.menu[].roles` is declared in `identity.roles`.
3. Every role in an `approvers` list has `canApprove: true`.
4. Every id in `toolAccess.elevation[].purposes` exists in `purposes`.
5. Tool names in `toolAccess`, `actions` and `persona.menu[].action.tool` refer to a declared HTTP or
   bundled tool, or to a tool of the MCP server the entry belongs to (MCP tool names are checked at
   discovery and logged, not refused at start).
6. `actions.*.authChallenge.type: face-match` requires `media.faceVerification`.
7. `features.rag` requires `rag`; `features.voiceNotes` requires `media.speechToText`;
   `features.inboundImages` requires `media.vision`; `features.imageGeneration` requires
   `media.imageGeneration`.
8. `tools.bundled.generateImage.provider` names a `media.imageGeneration.providers[].name`.
9. `channels.agui.walletLinkTemplate` starts with `https://` and contains `{oob}`.

## Differences from the previous generation of packs

For readers of the earlier `hologram-ai-agent` packs: `languages` (per-language prompts) is replaced by
one `language.agent` and the frontend's presentation language; `flows.authentication`
(credential definition ids, roles attribute, admin users) is replaced by `identity` (Verifiable Trust
resolution, role rules over verified facts, no admin bypass); `accessMode: user-controlled` and
`userConfig` are gone (deployment-held credentials only); `imageGeneration`, `speechToText` and
`vision` moved under `media`; `integrations` is gone (deployment values are environment variables);
`privacy`, `purposes`, `actions`, `sessions`, `channels`, `integrity` and `features` are new.
