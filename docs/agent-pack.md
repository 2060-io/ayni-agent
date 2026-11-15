# Agent pack, schema 3.0

The agent pack is the single configuration bundle of a Ayni Agent: everything about behavior and
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
| `identity` | yes | the agent's DID, user-agent gate, the authentication schema, organization patterns, roles, role rules, per-actor overrides | D30, D34, D37, D38 |
| `language` | yes | the one agent language | D21 |
| `persona` | yes | system prompt, greeting, contextual menu | D46, CORE-PROMPT |
| `llm` | yes | model provider and model | LLM-PROV |
| `embeddings` | yes | embeddings provider and model | LLM-EMB |
| `memory` | | context window, working memory, summarization, retrieval | D9, D10, D24, D25 |
| `rag` | | corpus sources with visibility | D42, MEM-RAG |
| `presentations` | | the credentials the agent may ask for, with what is kept and what the model reads | D69, INTX-PRES, PRIV-EVID |
| `issuance` | | the credentials the agent may issue, each claim with its source | D70, INTX-ISSUE |
| `tools` | | declarative HTTP tools, bundled tools, their access policy | TOOL-HTTP, TOOL-ACCESS |
| `mcp` | | MCP servers and per-server tool access | TOOL-MCP, D41 |
| `purposes` | | governance list for elevation | D14, D15 |
| `approvals` | | default approval and elevation policy | INTX-APPR |
| `actions` | | per-tool auth challenge and credential freshness | D7, D28, INTX-AUTH |
| `sessions` | | idle timeout, binding expiry, liveness TTL, sibling sessions, device pairing window | D6, D7, D36, D51 |
| `channels` | | AG-UI and A2A adapters | D1, D2, CHAN-* |
| `privacy` | yes | processing activities with lawful basis and retention, erasure | D18, PRIV-RETN |
| `media` | | speech-to-text, vision, image generation, face verification | D45, INTX-AUTH-007 |
| `integrity` | | anchoring cadence | D26, INTEG-ANCHOR |
| `statistics` | | statistics sink | PLAT-STATS |
| `features` | | feature gates | CORE-PROMPT-002 |

## identity

```yaml
identity:
  homeBackingIdentity: did:webvh:...          # the DID of this agent, the service its operator runs
  userAgentGate: required                     # required | optional
  authentication:                             # the one schema that authenticates a person (D65)
    - credential: { jsonSchemaCredentialId: https://.../vt/schemas-badge-jsc.json }
      subjectKey: [badgeNumber]
      request: on-connect                     # or on-demand: nothing is asked at connection
      attributes: [badgeNumber, name, title, department]
      store: { attributes: [name, title, department], retention: { days: 365, onExpiry: erase } }
      modelVisible: [name]
  organizations:                              # patterns over the verified Organization credential (D64)
    - match: { countryCode: EE, registryId: "14000000" }
      relation: partner
      roles: [partner]
      label: Baltic Forwarding
    - match: { countryCode: [DE, AT] }
      relation: unrecognized
      roles: [visitor]
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
    - { actor: <a person's key or a service's DID>, roles: [auditor] }
```

- **An organization is not a DID** (D64). The agent identifies the organization behind an actor by its
  **organization key**, computed from the verified ECS Organization credential that trust resolution returns:
  the country of registration and the identifier in its register (`org:EE:14000000`). A service that moves
  to another DID, and two services of one organization, are the same organization. An actor that only a
  Persona backs has no organization in this version.
- **`home` is never configured.** It is the organization of the agent's own Organization credential, read
  through the DID of the agent, and no other: its people get the `home` relation and the
  `organization-shared` memory. A pattern that sets `home` is refused at start-up. An agent that is not
  onboarded yet has no organization: nobody is home until it is.
- **`organizations`** recognizes every other organization by patterns over the verified attributes
  `countryCode`, `registryId`, `legalJurisdiction`, `organizationKind` and `lei`, in order, first match
  wins. A pattern sets the relation (`partner` or `unrecognized`) and may add `roles`. Naming
  `registryId` designates one organization; naming a country alone admits every accredited organization
  of that country, which belongs with low-privilege roles. No match: `unrecognized`, no added role.
- **`authentication`** names the one credential schema that authenticates a person, by its ecosystem
  schema, so that a credential of any accredited issuer satisfies the request; it is a list validated to
  exactly one entry. The agent takes the issuer from what the DIDComm agent verified in the proof, never
  from an attribute, and resolves the issuer's organization. The person is then
  `<organization key>|<schema>|<subject key>`: the same badge number from another organization is another
  person, and a badge re-issued by the same organization is the same person, whichever of its services
  issued it. A presentation that leaves a `subjectKey` attribute unrevealed identifies nobody, so the
  subject key must be among the `attributes` asked. An agent that authenticates nobody omits
  `authentication`: everyone then enters unidentified.
- **What is kept of a presented credential, and what the model reads of it** (D67, D68). Each verification
  leaves one **evidence** record. Its audit fields are in the clear and hold no attribute value: when, which
  Principal, which schema, the issuer and its organization, the outcome, the names of the attributes
  revealed and of those left unrevealed, the request and the connection. Three lists govern the values:
  `attributes` is what the agent asks of the wallet; `store.attributes` is what it keeps, sealed under a
  key of the record, for `retention.days` (kept until erased when absent); `modelVisible` is what the model
  may read. **By default nothing is stored and the model reads nothing**: an attribute that is asked and not
  stored serves the decision it was presented for (the role rules, the principal key) and is dropped. At the
  end of a retention `onExpiry: erase` (the default) destroys the key of the record, whose audit fields and
  digest remain; `archive` hides the values from the model and the tools and leaves them to an auditor. A
  credential presented again erases the values of the earlier record. A model-visible attribute must be
  stored and a stored attribute must be asked, or the pack is refused. The agent warns at start-up when a
  model-visible attribute is kept for less time than conversation memory, since what the model reads stays in
  the conversation. The person's name reaches the model, the greeting and the lists shown to other people
  only when `name` (or `userName`) is stored, and the model only when it is also visible; `photo` must be
  stored to serve as the reference of a face-match challenge. The `principal_credentials` tool lists the
  records with the visible attributes.

- **Role assignment is rules over verified facts, never rosters** (D34). A rule's `when` matches on the
  Principal's `relation` to this agent (`home`, `partner`, `unrecognized`), its `connectionType`,
  whether the ECS-UserAgent credential was presented (`userAgentVerified`), and verified `claims`
  (ECS-Badge facts such as `department` or `title`; ECS-Service attributes for services). A list value
  matches any of its entries. The first matching rule wins, and its roles are added to those of the
  organization's pattern. No match: the Principal has the roles of its pattern, if any; an `unrecognized`
  organization gives no backing identity and `public` visibility only.
- `perActorOverrides` apply before the rules, for named actors: a service by its DID, a person by the key
  above.
- `roles` declares every role used anywhere in the pack. `crossSession` sets the role's cross-session
  memory scope (RBAC-XSESS): `own-sessions` (default), `own-backing-identity`, `all`. `canApprove`
  marks roles that may appear in `approvers`. `auditor` grants read-only access to the whole
  persistent store outside LLM retrieval.
- **Who enters unidentified follows from `authentication`, and from nothing else** (D53). A pack that names
  no authentication schema lets every wallet in, unidentified. One that asks `on-connect` (the default)
  identifies a person or refuses them, with a short message. One that asks `on-demand` asks nothing at
  connection: the person enters unidentified and identifies later. An unidentified person is a Principal
  without backing identity: relation `unrecognized`, `public` visibility only, the role rules decide the
  rest. The agent says at start-up that it admits unidentified peers. There is no separate setting: the
  earlier `unidentifiedPeers` and the `UNIDENTIFIED_PEERS` variable are gone (the variable is ignored, with
  a warning). `DEV_ALLOW_UNIDENTIFIED_PRINCIPALS` stays, for development only.
- **Identifying later** (D65, D66). While a connection is unidentified, the credential is asked when the
  model calls `request_presentation` with the entry `authentication` (the tool exists for an unidentified
  person only, takes nothing else, and answers with a status) or when the person picks **Identify
  yourself** in the menu. The agent does not insist: one request at a time on a connection, and after a
  request that was declined or left unanswered the model waits ten minutes; the person's own request is
  always served. A valid credential upgrades the connection to the Principal it identifies, and the
  conversations held before, with their sessions and entries, move to it; working memory and preferences
  of the visitor are not merged. A connection that is already identified accepts the credential of the same
  person only: another identity is refused and nothing of it is kept. Issuing a credential never
  identifies: the person presents it.
- `userAgentGate: optional` lets wallets that do not present an ECS-UserAgent credential connect; the
  Principal is then marked `userAgentVerified: false`, which `roleRules` may use.
- `credentials` names the other credentials the agent requests on DIDComm connect (IDENT-RES-001/003):
  `userAgent` (the ECS-UserAgent credential of the gate) and `service` (credentials accepted from a
  verifiable-service peer). Each entry is a `jsonSchemaCredentialId` or a `credentialDefinitionId`
  the DIDComm agent can resolve, with optional `attributes`. The credential that authenticates a person
  is `authentication`, above; `credentials.badge` no longer exists.

## persona

- `systemPrompt` is the author's prompt. The platform appends its own system-prompt add-on (working
  memory rules, scoped retrieval, challenges, reaction policy, tools); the persona never overrides it.
- `greeting` is sent on first contact and on every new conversation, never to a session that continues a
  conversation (a reconnection, another device linked to it); `{userName}` is replaced.
- `menu` items are the author's contextual menu. Platform items (sessions, approvals with badge) are
  added automatically. An item's `action` is `prompt` (sends a text as the user's turn), `tool` (calls
  a tool directly, subject to the same access tiers) or `url`. `visibleWhen` is `always`, `bound`
  (only to bound Principals) or `role` with a `roles` list.

## llm and embeddings

`provider` selects an adapter: native (`openai`, `anthropic`, `ollama`), the generic chat-completions
adapter (`openai-compatible`, for gateways such as OpenRouter or LiteLLM and any compatible endpoint,
`baseUrl` required) or a special-protocol adapter (`azure-openai`, `bedrock`, `vertex`, with
`provider_options` as the adapter documents). `stub` is a deterministic offline model for
development and tests (it echoes, and `/call <tool> {json}` triggers a tool call); the same value
exists for `embeddings.provider`, and `model: stub` for `media.speechToText`, `media.vision` and an
image generation provider.

Kimi (Moonshot) is an `openai-compatible` endpoint: `baseUrl: https://api.moonshot.ai/v1` (or the
`LLM_BASE_URL` variable), `model: kimi-k3`, the key in `LLM_API_KEY`; omit `temperature` (the K3
API does not list it) and use `reasoningEffort: low | high | max` if wanted. Kimi offers no
embeddings endpoint: keep another `embeddings.provider`. `apiKeyEnv` names the environment variable holding the
key; keys never appear in the pack. `multimodal: true` lets a capable model receive referenced media;
the agent never depends on it. Embeddings are configured independently and may use another provider.

## memory, rag

- `memory.contextWindowTokens` is the token budget of the active window (token-based, D25).
- `workingMemory` is the LLM-curated, principal-scoped note store; `summarization` compresses the
  window transiently; `retrieval` tunes the semantic index (`topK`, chunking, ambient descriptions).
- `rag.sources` are agent-level knowledge, chunked and embedded. Each source declares a `visibility`
  (`public` default, `organization-shared`, `partner-shared`) and is retrieved through the same scope
  predicate as memory (MEM-RAG-005). `url` sources may be refreshed on an interval.

## presentations

The credentials the agent may ask for beyond the one that authenticates: a closed list, each entry under a
name (D69). The agent asks for nothing else.

```yaml
presentations:
  diploma:
    credential: { jsonSchemaCredentialId: https://.../vt/schemas-diploma-jsc.json }
    subjectKind: person              # person (default) or service
    request: on-demand               # or on-connect
    purpose: Check your degree for the application
    attributes: [degree, institution, graduationDate]
    store: { attributes: [degree, institution], retention: { days: 365, onExpiry: erase } }
    modelVisible: [degree]
```

- `request: on-connect` entries are asked by the code when the connection is established, one after the
  other, after the authentication when it is asked on connect. `on-demand` entries are asked when the model
  calls `request_presentation` with the name of the entry. The tool takes the name and nothing else: the
  schema, the attributes, the purpose and the recipient are the entry's and the connection's.
- An entry is asked only of a peer of the `subjectKind` of its schema: a person behind a user agent, or a
  service. Under Verifiable Trust v4 the pack declares it; under v5 the schema does.
- `purpose` is what the person reads in the wallet before answering.
- What comes back is **evidence** of the Principal of the connection, kept and shown to the model by the
  three lists `attributes`, `store` and `modelVisible`, exactly as for `identity.authentication`. It never
  binds a Principal: only the authentication does. The issuer is the one the DIDComm agent verified in the
  proof; a presentation whose record reports no issuer is not evidence.
- The model gets a status: `verified`, or `not presented` when the request was declined or left
  unanswered, which says nothing about whether the credential is held. After that the model waits ten
  minutes before the same entry can be asked again; one request is pending on a connection at a time.
- The name `authentication` is reserved: it is the entry of `identity.authentication`, which the same tool
  offers to an unidentified person.

## issuance

The credentials the agent may issue: a closed list, each under a name (D70). A profile gives **every claim one
source**, and the model is never a source.

```yaml
issuance:
  alumni_card:
    credential: { credentialDefinitionId: did:webvh:.../resources/... }
    label: Alumni card
    trigger: model                     # model (default) | request | automatic
    roles: [member]                    # optional: who may receive it
    authChallenge: { type: device }    # optional: enforced before the issuance
    evidenceMaxAgeMinutes: 60          # optional: older evidence is expired for this profile
    claims:
      degree:   { from: evidence, entry: diploma, attribute: degree }
      name:     { from: evidence, entry: authentication, attribute: name }
      issuedOn: { from: computed, fn: today }
      status:   { from: computed, fn: constant, value: active }
    record: { storeClaims: false, retention: { days: 365, onExpiry: erase } }
```

- **Sources.** `evidence` reads an attribute of a verified presentation: the `authentication`, or an entry
  of `presentations`. The attribute must be among those the entry **stores**, or the pack is refused: what
  is not kept cannot be issued from. `computed` is `today`, `now`, `addDays` (with `days`), `constant`
  (with `value`) or `subjectId`; the list is closed, and another name is refused. A system of record, a
  human attestation and a value declared by the peer are named by the specification and not available in
  this version; neither is a value read from a document.
- **An identifier of the subject.** `subjectId` gives a claim that numbers the holders of an issuer, such
  as `badgeNumber`: 16 characters derived from the Principal and the name of the profile with a key of the
  deployment (from `ENTRY_ENCRYPTION_KEY`). The same person gets the same number under the same profile at
  every issuance, two persons never the same one, and the number shows nothing of the Principal. It
  follows the Principal: a person who connects again unidentified is another Principal, with another
  number.
- **Two tools.** `credential_requirements` is read-only and passes no gate. For each credential the person
  may receive it answers `held`, `ready` or `incomplete`, and for each claim a status without any value:
  `available`, `missing`, `expired`, `not-revealed` or `unavailable`. A claim that is not available names
  what obtains it: `request_presentation` with an entry, or nothing to do. `issue_credential` takes the
  name of the credential and nothing else: the agent resolves the claims itself, for the person of the
  session, offers the credential to their wallet, and issues nothing when a claim cannot be resolved,
  answering with the same list.
- **Triggers.** `model`: the model calls `issue_credential`. `request`: the person asks, from a menu item
  "Get <label>"; the credential is absent from the model's list. `automatic`: the agent issues as soon as
  every claim resolves, when evidence arrives. `credential_requirements` is there in the three cases.
- **Gates.** `roles` limits who may receive the credential. `authChallenge` runs before the offer, as for
  any action. A credential is issued once to a Principal.
- **Persons only** in this version: a credential is offered on the connection of the person, as an `issue`
  flow on a flow-capable wallet.
- **The record.** Each issuance leaves a record built as evidence is: the audit fields always (the profile,
  the credential definition, the exchange, the evidence its claims came from), the issued claims sealed
  and kept only with `storeClaims`, for the `retention` given.

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

`sessions.devicePairing` sets how long a browser the phone confirmed once keeps binding new sessions
without the phone: `slidingDays` since the last use (default 30; 0 disables silent binding, every
session then asks the phone) and `maxDays` since the pairing (default 90). Each silent binding rotates
the device secret; a stale secret revokes the pairing (D51, IDENT-DEV).

`sessions` sets the idle timeout, the binding window (invitation and code lifetime), the liveness TTL
`N` and whether sibling sessions may be opened from a bound token. `channels.agui` sets the UI origins
allowed by CORS, the wallet link template (an HTTPS app link with `{oob}`, never `didcomm://`) and the
upload limits published in the descriptor. DIDComm is always on.

A person can have the same conversation open on several devices at once (the phone and a laptop, two
browsers). Nothing in the pack turns this on or off: each device holds its own session on the
conversation, the agent sends each of them what the others add as it happens, and history gives every
one of them the whole conversation (D61, IDENT-SESS-016). The idle timeout still applies to each session
on its own; a device whose session was closed opens a new one on the same conversation and reads what it
missed.

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

1. `identity.authentication` holds at most one entry, whose `subjectKey` is among the `attributes` it asks;
   no `identity.organizations` pattern sets `relation: home`.
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
