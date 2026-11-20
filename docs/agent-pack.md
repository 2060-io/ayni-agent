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

Relative paths (`rag.sources[].path`) resolve from the pack directory.

## Top-level sections

| Section | Required | What it holds | Spec |
|---------|----------|---------------|------|
| `schemaVersion` | yes | `"3.x"`; the loader refuses another major | CORE-PACK-004 |
| `metadata` | yes | id, display name, description, tags | |
| `identity` | yes | the agent's DID, user-agent gate, the authentication schema, organization patterns, roles, role rules, per-actor overrides, the file of the user directory | D30, D34, D37, D38, D79 |
| `language` | yes | the one agent language; `language.agent` is also the language of the messages the agent's code writes itself (the email check's) for a person whose language is not known, and their fallback (decision 64) | D21, D94 |
| `persona` | yes | system prompt, greeting, contextual menu | D46, CORE-PROMPT |
| `llm` | yes | model provider and model | LLM-PROV |
| `embeddings` | yes | embeddings provider and model | LLM-EMB |
| `memory` | | context window, working memory, summarization, retrieval | D9, D10, D24, D25 |
| `rag` | | corpus sources with visibility | D42, MEM-RAG |
| `presentations` | | the credentials the agent may ask for, with what is kept and what the model reads | D69, INTX-PRES, PRIV-EVID |
| `evidence` | | what is kept of a document read, and what the model reads of it | D73, PRIV-EVID |
| `issuance` | | the credentials the agent may issue, each claim with its source | D70, INTX-ISSUE |
| `tools` | | `tools.sources`: the catalog of tool sources, one map keyed by source id (MCP servers, HTTP tools, bundled tools), each with its connection, account, availability, access tiers and what it says of each tool, step-up included | D96 to D101, TOOL-CAT, TOOL-MCP, TOOL-HTTP |
| `purposes` | | governance list for elevation | D14, D15 |
| `approvals` | | default approval and elevation policy | INTX-APPR |
| `sessions` | | idle timeout, binding expiry, liveness TTL, sibling sessions, device pairing window | D6, D7, D36, D51 |
| `conversations` | | the window within which a person deletes a message of theirs | decision 60 of the agent |
| `spaces` | | the templates people with a role create spaces from | decision 60 of the agent |
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
      guests: false                           # true: the person may continue as a guest (with on-connect)
      issuers: { organizations: ["org:EE:14000000"] }   # whose credentials are accepted; any issuer when absent
      obtain: { text: "Ask your front desk for your badge.", url: https://.../badge }   # how to obtain it
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
    finance-manager: { canApprove: true }
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

- **Role assignment is rules over verified facts and, with a user directory, the roles its entries give by hand**
  (D34, D87; below). The directory is the only list of people. A rule's `when` matches on the
  Principal's `relation` to this agent (`home`, `partner`, `unrecognized`), its `connectionType`,
  whether the ECS-UserAgent credential was presented (`userAgentVerified`), and verified `claims`
  (ECS-Badge facts such as `department` or `title`; ECS-Service attributes for services). A list value
  matches any of its entries. The first matching rule wins, and its roles are added to those of the
  organization's pattern. No match: the Principal has the roles of its pattern, if any; an `unrecognized`
  organization gives no backing identity and `public` visibility only.
- `perActorOverrides` apply before the rules, for named actors: a service by its DID, a person by the key
  above.
- `roles` declares every role used anywhere in the pack. **No role reads other people's conversations**
  (RBAC-XSESS-005/007): `crossSession`, the role-wide conversation reads of an earlier version, is withdrawn, and a
  pack that declares it, whatever its value, is refused with a message that says so. A conversation is read by its
  author, by the active members of its space once its author shares it with the space, and by an auditor through
  the admin interface. `canApprove` marks roles that may appear in `approvers`. `auditor` grants read-only access to
  the whole persistent store outside LLM retrieval. `admin` lets the role read the admin view of roles and changes
  (IDENT-DIR-008, with the user directory).
- **Who enters unidentified follows from `authentication`, and from nothing else** (D53, D72). A pack that
  names no authentication schema lets every wallet in, unidentified. One that names a schema is in one of
  three modes:

  | Mode | Pack | At connection |
  |---|---|---|
  | required | `request: on-connect` | the credential is asked; nothing opens without it |
  | offered | `request: on-connect`, `guests: true` | the credential is asked; the person may continue as a guest |
  | on request | `request: on-demand` | nothing is asked; the person enters as a guest and authenticates when they ask |

  `on-demand` lets guests in by itself: `guests: false` with it is refused at start-up.
- **The request at connection** (D72). It is valid five minutes. A credential that is not accepted is
  answered with its reason and asked again, with no limit: the person ends it by declining. A decline ends
  the connection when the credential is required and lets the person in as a guest when it is offered. No
  answer in time ends the connection in both. Nothing is open before the outcome, so no conversation
  exists before it; a person who authenticates finds their conversations.
- **Whose credentials are accepted** (D72). With no `issuers`, the credential of any accredited issuer of
  the schema that an organization backs. With `issuers.organizations`, only the credentials whose issuer
  is one of those organizations, by organization key (`org:<country>:<register id>`). The agent decides
  this when it verifies the presentation; the wallet is told the list so that it offers no other.
- **How the credential is obtained** (D72). `obtain` is the operator's own text, with a link when there is
  one. The wallet shows it to a person who holds no such credential, or whose credential was not accepted.
- An unidentified person, a guest, is a Principal
  without backing identity: relation `unrecognized`, `public` visibility only, the role rules decide the
  rest. The agent says at start-up that it admits unidentified peers. There is no separate setting: the
  earlier `unidentifiedPeers` and the `UNIDENTIFIED_PEERS` variable are gone (the variable is ignored, with
  a warning). `DEV_ALLOW_UNIDENTIFIED_PRINCIPALS` stays, for development only.
- **The wallet is told where it stands** (D71, D72). The same entry gives the status message the agent sends
  on each connection: the rule, `none` with no authentication schema, `optional` when guests are let in,
  `required` when they are not; the schema asked for; the organizations accepted, when the pack lists any;
  and how the credential is obtained, when the pack says it. The message also says whether the person is
  identified and what is open to them, so the app knows whether to wait for the request, and when it may
  open the conversation. Nothing else is configured for it.
- **Authenticating later** (D65, D66, D72). While a connection is unidentified, the credential is asked when
  the person asks from their wallet (the Ayni app's **Authenticate**, in the service's menu, which needs no
  conversation), when the person picks **Authenticate** in the agent's own menu (sent to the web UI and to
  other clients, not to the Ayni app), or when the model calls `request_presentation` with the entry
  `authentication` (the tool exists for an unidentified person only, takes nothing else, and answers with
  a status). A request made this way, declined or left unanswered, changes nothing: the person stays a
  guest. The agent does not insist: one request at a time on a connection, and after a
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

### The user directory (`identity.directory`)

When no identity provider is configured, the people of the home organization and their roles are a **user directory**
(ayni-spec D79, D87, D91, D92; agent decision 61): a file the pack names, mounted from a secret of the deployment.
The people are **never written in the pack**, which is versioned with the deployment and would keep every former
employee in its history: a pack that lists them (`identity.directory.people`, `identity.people`, or a list under
`identity.directory`) is refused at start, in words.

```yaml
identity:
  directory:
    file: /run/secrets/ayni/directory.yaml    # a relative path resolves from the pack directory
  roles:
    dispatcher: { description: Dispatches the trucks. }
    people-admin: { description: Reads who holds which role., admin: true }
```

```yaml
# the file, YAML or JSON
people:
  - id: p-0042                    # stable, unique
    firstName: Ana
    lastName: Ríos
    email: ana.rios@northwind.example        # unique, compared in lower case
    birthDate: 19910521           # YYYYMMDD; only when badges are obtained with a passport
    nationality: ESP              # the code of ICAO Doc 9303; idem
    department: Depot Rotterdam   # optional: rule spaces only
    groups: [fleet-safety, night-shift]      # optional, several: rule spaces only
    roles: [dispatcher]           # typed by hand, roles of identity.roles
```

- **Validation.** Every scalar is read as text (an id `0042` keeps its zeros). Ids and emails are unique, roles are
  declared, no other field is allowed, and a birthdate and a nationality are required on every entry when an issuance
  profile obtains badges from the directory with a passport. At start a file that does not validate stops the agent,
  naming each entry and field at fault; the message never carries a birthdate or a nationality.
- **Reload.** The agent watches the directory of the file (a Kubernetes Secret is updated by swapping the `..data`
  symlink in it, whatever the mount) and reads the file again every `DIRECTORY_POLL_SECONDS` (10; 0 watches only),
  comparing its content by hash. A new version that does not validate is not loaded: the one in force stays and the
  reason goes to the log.
- **Roles by hand (D87).** A Principal holds the entry its identity credential was issued from, by this agent: the
  issuance record names the entry, and the credential, once presented, finds its record. The entry's roles join those
  of the Principal's verified facts, from its next request after a reload. No role rule reads an entry: a rule that
  names `claims` does not match a Principal whose badge this agent issued from an entry (those claims are the entry's
  fields); the relation keeps its rules, and the claims of badges issued by others keep theirs (IDENT-ROLE-014). A
  Principal whose badge was not issued from an entry receives no role from the directory.
- **`department` and `groups`** make people members of the rule spaces that name them (`spaces.templates[].membership`),
  and nothing else.
- **What each load changed** is written to the admin audit, one record per entry added, removed or changed: its id,
  its name, the names of the fields that changed, the roles before and after; never a value of a birthdate or a
  nationality. The last load is kept sealed in the store, so that what changed while the agent was down is recorded,
  and acted on, at start.
- **Removal (D91).** A person whose entry leaves the directory loses it and the roles it gave, and every session of
  theirs is closed at once with `credential-invalid`, their devices unpaired; then every credential issued from the
  entry is revoked and its holder told (`revocation_notification`). A revocation the DIDComm agent cannot make is made
  again later. An invitation to a list space of a person no longer listed is removed.
- **Who reads it.** The member picker of list spaces (`GET {sessions}/directory?q=`) gives names and departments, to a
  person who owns a list space or may create one. The admin view (`GET {sessions}/admin/roles` and `/admin/changes`)
  gives every entry with its roles and whether a Principal holds it, and the changes, to the holders of a role marked
  `admin`. The model reads nothing of the directory.
- **Badges from it.** An issuance profile may take its claims from the entry of the person, found with a passport or an
  email code: see `issuance`, "A badge from the user directory".

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

`providerName` names the model provider as the spaces' `allowedProviders` list it: `kimi` for `openai-compatible` on
Moonshot, for example; `provider` when absent (SPACE-CONV-004).

`maxInputTokens` is the model's input limit (Kimi K3: 1M); the agent refuses to start when
`memory.contextWindowTokens` plus `maxOutputTokens` exceeds it (MEM-CTX-006). `cache` turns on the provider's
caching by prefix (LLM-CACHE-001): `enabled: true` sends the conversation as the cache key and `ttl` (`5m` by
default, or `1h`) as the lifetime of what each call writes. Kimi first: `prompt_cache_key` and
`prompt_cache_options.ttl`. Every call reports what the provider counted (input, cached, written to the cache,
output): the turn keeps it with its reply, the statistics count it, and the conversation shows its context figure
below the message form (D74).

## memory, rag

- `memory.contextWindowTokens` is the token budget of the context window (token-based, D25), counted over what
  the model receives: every message as rendered, the system parts, the tool definitions, what retrieval adds,
  scaled by the ratio the provider last reported (MEM-CTX-002). The Welcome pack reads it from
  `CONTEXT_WINDOW_TOKENS`.
- `memory.window` makes the window move in steps (MEM-CTX-003): it keeps its first entry while the context fits;
  past the budget (or `summarization.triggerTokens`), it drops its oldest entries in one step, down to `keepRatio`
  of the budget (0.6), and never reads more than `maxEntries` entries (400). Between steps the start of the
  request does not change, so the provider serves it from its cache.
- `memory.summarization` (on by default) compresses what a step drops, with the previous summary, into the
  conversation summary (MEM-CTX-004), which the model reads after the system parts as a record of the system.
  `maxSummaryTokens` (4000) bounds it. The summary is sealed apart from the entries, never an entry, and made again
  when an entry it covers is erased (MEM-TIER-004).
- `workingMemory` is the LLM-curated, principal-scoped note store; a note cites the message it came from, so that
  the erasure of that message flags it. `retrieval` tunes the semantic index (`topK`, chunking, ambient
  descriptions); recall never repeats the window and says whether an entry comes from this conversation or another
  (MEM-RET-007).
- `rag.sources` are agent-level knowledge, chunked and embedded. Each source declares a `visibility`
  (`public` default, `organization-shared` for the Principals of the agent's own organization, `partner-shared`
  with `partner`, the organization key of the partner) and is retrieved through the same scope predicate as
  memory, compiled for the documents' store (MEM-RAG-005, D76). `url` sources may be refreshed on an interval.

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

- **The credential, by definition or by schema.** `credential` names one of the two.
  `credentialDefinitionId` is a credential definition of this agent. `jsonSchemaCredentialId` is the schema
  of the credential in its ecosystem, as a presentation entry names it: the agent then issues under the
  definition its VS Agent holds for that schema, and creates it at start when there is none. The identifier
  of a definition holds the DID of the agent and changes with every new wallet, so a pack that names the
  schema serves any deployment. While the definition cannot be established (the VS Agent out of reach, the
  ecosystem not publishing its AnonCreds schema yet) nothing is issued under the profile, the model is told
  so, and the agent looks again at the next issuance.
- **Sources.** `evidence` reads an attribute of a verified presentation: the `authentication`, or an entry
  of `presentations`. The attribute must be among those the entry **stores**, or the pack is refused: what
  is not kept cannot be issued from; `as: dateint` writes a calendar date as the integer `YYYYMMDD`.
  `computed` is `today`, `now`, `addDays` (with `days`), `constant` (with `value`), `subjectId`,
  `documentId` or `emailId`; the list is closed, and another name is refused. `record` reads a field of the
  person's entry of the **user directory** (`record: directory`), the one system of record of this version:
  see "A badge from the user directory" below. A human attestation and a value declared by the peer are
  named by the specification and not available in this version. `evidence` also reads a **document** and a
  **verified email address**: see below.
- **An identifier of the subject.** `subjectId` gives a claim that numbers the holders of an issuer, such
  as `badgeNumber`: 16 characters derived from the Principal and the name of the profile with a key of the
  deployment (from `ENTRY_ENCRYPTION_KEY`). The same person gets the same number under the same profile at
  every issuance, two persons never the same one, and the number shows nothing of the Principal. It
  follows the Principal: a person who connects again unidentified is another Principal, with another
  number.
- **A credential from a passport or an identity card (D73).** The entry `document` is the read of a
  document's chip. It is declared once, under `evidence`, and read by the challenge of the profile:

  ```yaml
  evidence:
    document:
      store: { attributes: [documentNumber, issuingState, fullName, dateOfBirth, portrait], retention: { days: 1, onExpiry: erase } }
      modelVisible: []
  issuance:
    badge:
      credential: { jsonSchemaCredentialId: <schema> }
      authChallenge: { type: document }          # the read: the phone asks the person for their document
      evidenceMaxAgeMinutes: 15                  # a read older than this is done again
      claims:
        badgeNumber: { from: computed, fn: documentId }
        name:        { from: evidence, entry: document, attribute: fullName }
        birthDate:   { from: evidence, entry: document, attribute: dateOfBirth }
        photo:       { from: evidence, entry: document, attribute: portrait }
  ```

  - **The attributes** are a closed list, the same for every document: `documentType` (`passport`,
    `identity-card` or `travel-document`), `documentNumber`, `issuingState`, `nationality`, `lastName`,
    `firstName`, `fullName` (first names, then last name), `dateOfBirth`, `dateOfExpiry`, `sex` (`M`, `F`
    or `X`) and `portrait`. Names are those of the machine-readable zone: in capitals, without accents.
    Dates are `YYYY-MM-DD`. The portrait is a JPEG data URL, at most 240 pixels on its longer side.
  - **What is kept.** The read is kept only when the VS Agent says that the data is signed under a
    certificate of the issuing state it trusts and that the data matches the signature, and when the
    document has not expired. Otherwise it is recorded with its reason and no value, and nothing is
    issued. The VS Agent needs the list of state certificates for this
    (`MRTD_MASTER_LIST_CSCA_LOCATION`) and the image that carries the passport module: without the list
    every read fails as not verified.
  - **How it runs.** The model, or the person from the menu, asks for the credential. The agent opens a
    passport flow on the phone, valid five minutes, and waits. A phone that did not say it can read a chip
    is not asked: the issuance answers that the phone cannot. A read that is still good, by
    `evidenceMaxAgeMinutes` and by the retention, is not asked again.
  - **`documentId`** numbers the holders by their document: 16 characters derived from the issuing state
    and the number of the document with the key of the deployment. One document gives one number through
    any connection, so a person who lost their wallet reads the same passport and is the same holder; a
    renewed document gives another number. It needs `documentNumber` and `issuingState` among the stored
    attributes.
  - **Refused by the loader:** a profile that takes a claim from a document without the `document`
    challenge, or with the trigger `automatic`; `documentId` without the two attributes stored; a stored
    attribute that is not of the list; a presentation entry named `document`.
  - **What it proves:** that the document was in hand. The chip is not checked against a copy, and nobody
    compares the holder with the portrait.
- **A badge from the user directory (D88, D89; decision 62).** With a user directory the agent issues the badges of
  its own organization from it. The person shows which entry is theirs as the profile's challenges say: a passport
  (`[{ type: document }]`), an email code (`[{ type: email }]`), or both, in this order:

  ```yaml
  evidence:
    email: { store: { attributes: [address], retention: { days: 30 } } }   # needed with an email code
    document:                                    # needed with a passport: what the match reads
      store: { attributes: [documentNumber, issuingState, nationality, lastName, firstName, dateOfBirth, portrait] }
  issuance:
    badge:
      credential: { jsonSchemaCredentialId: <the ECS Badge schema of the ecosystem> }
      label: Northwind badge
      trigger: model
      authChallenge: [{ type: email }]           # [{ type: document }], or [{ type: document }, { type: email }]
      claims:
        badgeNumber: { from: computed, fn: emailId }                    # documentId with a passport
        name:        { from: record, record: directory, field: name }   # first and last name
        email:       { from: record, record: directory, field: email }
        department:  { from: record, record: directory, field: department }
        birthDate:   { from: computed, fn: constant, value: "" }        # with a passport:
                                                                        # { from: evidence, entry: document, attribute: dateOfBirth, as: dateint }
        photo:       { from: computed, fn: constant, value: "" }        # with a passport: { from: evidence, entry: document, attribute: portrait }
        phoneNumber: { from: computed, fn: constant, value: "" }
  ```

  - **The entry.** A passport finds the one entry whose date of birth and nationality equal the document's, whose last
    name equals the document's and whose first names are among its given names, in their order, after the names of the
    entry are written as the machine-readable zone writes them (ICAO Doc 9303, Part 3: capitals A to Z; `Ríos` is
    `RIOS`, `Müller` is `MUELLER`, `MUXXLLER` or `MULLER`; an apostrophe dropped; a space or a hyphen a separator). A
    name the zone cut for want of room matches what it holds. An email code finds the entry that holds the verified
    address. With both, the two must find the same entry. None, two, or two different ones: the claims of the
    directory are `missing`, and the log says why, with no value.
  - **`record: directory`** takes `name` (first and last name), `firstName`, `lastName`, `email` or `department` (empty
    when the entry has none). Before the evidence that finds the entry exists, the claim is `pending`, and its action is
    the profile's own challenge: the credential is `ready`. The issuance record keeps the entry, which the person who
    presents the badge then holds, with its roles; the badge is revoked when the entry leaves the directory.
  - **The email code.** The issuing call ends the turn of the model with a question the agent's code writes in the
    conversation: which address the organization knows the person by. While the check waits, a message of the person
    there, from any device, that holds an address (then a code of six digits, which may be split by spaces or dashes)
    is the code's: it starts no turn and never reaches the model, which reads a record in its place, and the clients
    draw it as a message the AI never read. The code's own messages are the agent's in the model's conversation. Any
    other message ("the email did not arrive") goes
    to the model as usual and counts no try. The answer to the address is the same whether or not an entry holds it;
    a six-digit code is sent, by email, only to an address an entry holds. It is valid ten minutes, with five tries in
    all; `cancel` stops the check. A right code records the address as evidence (`evidence.email`, never shown to the
    model) and the issuance goes on by itself, offering the badge with no new turn of the model. The model is told
    `passed`, `failed` or `expired`, and nothing else. A guest who receives the badge is asked at once to present it,
    which identifies them (issuing identifies nobody).
  - **Its messages are in the person's language** (decision 64): the language of the preference `language` (a BCP 47
    tag the model stores when the person states one), else the locale of the session, else `language.agent`. The code
    writes them in English and has the model translate each finished sentence once per language, with no context (the
    sentence and the target language only, never anything the person typed); the translations are kept in the store.
    A translation that fails, or drops a number or a name, is not used: the message is then in `language.agent`, and
    in English when even that cannot be had. Nothing is configured for it.
  - **The tool `email_check`** is given to the model whenever a profile declares an email challenge (no source names
    it: it has no switch): `status` (whether a check waits, where, at which step, the time, tries and resends left),
    `resend` (a new code to the same address, the previous one no longer valid and the ten minutes started again; three
    times at most per check, thirty seconds apart, none before an address) and `cancel`. It never answers the address
    or the code.
  - **`emailId`** numbers a badge by the verified address, as `documentId` does by the document: the same address gives
    the same number to whoever proves it, an address that changes in the directory gives another one.
  - **Email** goes through the SMTP server of the deployment (`MAIL_HOST`, `MAIL_PORT`, `MAIL_ENCRYPTION`, `MAIL_USERNAME`,
    `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`: the variables of the 2060.io website). Without `MAIL_HOST`
    and `MAIL_FROM_ADDRESS`, the email code
    is unavailable: the claims it serves are `unavailable`, and the agent says so at start, naming the profiles.
  - **Refused by the loader:** a profile that takes a claim from the directory with no challenge, another challenge or
    another order; a directory claim with no `identity.directory`; a passport without `nationality`, `lastName`,
    `firstName` and `dateOfBirth` stored; an email challenge without `evidence.email` storing `address`, with
    `evidence.email.modelVisible`, on a profile that takes nothing from the directory, on an `automatic` profile, or in
    a tool's `stepUp` (in words, before the schema); `emailId` without an email challenge.
- **Two tools.** `credential_requirements` is read-only and passes no gate. For each credential the person
  may receive it answers `held`, `ready` or `incomplete`, and for each claim a status without any value:
  `available`, `missing`, `expired`, `not-revealed`, `unavailable` or `pending` (a claim of the directory whose
  evidence does not exist yet). A claim that is not available names what obtains it: `request_presentation`
  with an entry, `issue_credential` with the profile and the `challenge` (`document` or `email`) when the
  issuance itself obtains it (the credential is then `ready`), or nothing to do. `issue_credential` takes the
  name of the credential and nothing else: the agent resolves the claims itself, for the person of the
  session, offers the credential to their wallet, and issues nothing when a claim cannot be resolved,
  answering with the same list.
- **Triggers.** `model`: the model calls `issue_credential`. `request`: the person asks, from a menu item
  "Get <label>"; the credential is absent from the model's list. `automatic`: the agent issues as soon as
  every claim resolves, when evidence arrives. `credential_requirements` is there in the three cases.
- **Gates.** `roles` limits who may receive the credential. `authChallenge` runs before the offer, as for
  any action: one challenge, or a list of them, run in their order (a list is for a badge from the directory
  only). A credential is issued once to a Principal.
- **Persons only** in this version: a credential is offered on the connection of the person, as an `issue`
  flow on a flow-capable wallet.
- **The record.** Each issuance leaves a record built as evidence is: the audit fields always (the profile,
  the credential definition, the exchange, the evidence its claims came from), the issued claims sealed
  and kept only with `storeClaims`, for the `retention` given.
- **Revocation (decision 61).** A credential that must be revocable, one whose claims come from the user directory, is
  issued under a definition created with revocation, and nothing of it is issued otherwise. Under a revocable
  definition every credential takes a revocation registry and an index, which the agent allocates (the DIDComm agent
  takes both from the caller) and keeps in the record, with the entry it came from and a keyed index of the actor it
  identifies. The DIDComm agent keeps one definition per schema: when the one it holds for the badge schema was created
  without revocation, the agent issues no badge from the directory under it and says so in the log; delete that
  definition in the DIDComm agent (`DELETE /v2/anoncreds/credential-definitions/{id}`) and the agent creates a
  revocable one.

## tools: the catalog of tool sources

Every tool source is one entry of the map `tools.sources`, keyed by the source's **id** (ayni-spec D101, TOOL-CAT-001):
an MCP server, an HTTP tool or a bundled tool, with everything the pack says of it in that one entry. The id is what the
AG-UI profile carries as `source`, what a template of spaces names, and, for an HTTP tool, the name of its one tool. It
starts with a letter or a digit, then letters, digits, `_` and `-`, 64 at most.

| Key | Sources | What it says | Default |
|---|---|---|---|
| `type` | all | `mcp`, `http` or `bundled` | required |
| `transport`, `url`, `command`, `args`, `env`, `headers`, `lazy`, `reconnect` | `mcp` | the connection: `stdio` needs `command`, `sse` and `streamable-http` need `url`; `headers` and `env` hold the agent's account as placeholders | `lazy: true`, `reconnect: true` |
| `description`, `method`, `url`, `headers`, `parameters`, `bodyTemplate`, `timeoutSeconds` | `http` | the request: `description` is what the model reads of the tool (required), `parameters` the JSON Schema of its arguments, `{param}` placeholders in `url` and `bodyTemplate` | `timeoutSeconds: 30` |
| `bundled`, `enabled` | `bundled` | the bundled tool it names (below), and `enabled: false` to turn off one that is on by default; `endpoint` and `defaultStatClass` for `statistics`, `provider` for `generateImage` | `enabled: true` |
| `title`, `description` | all | what people read on the cards, in the sources and in a space's settings | the id; none |
| `account` | `mcp`, `http` | whose account its calls run with: `none`, `agent`, `space` (below) | `agent` |
| `availability` | all | `agent` (every conversation, Personal included), `personal` (Personal only), `spaces` (the spaces whose template names it) | `agent` |
| `offer` | `mcp` | the tools of the server the model is given | every tool it lists |
| `bindings` | `mcp`, `http` | the parameters the agent pins (below) | none |
| `untrusted` | `mcp`, `http` | what it returns was written outside the organization | from `openWorldHint` for an MCP tool; `false` for an HTTP tool |
| `access` | all | who may use its tools: `roles`, `approval`, `elevation`, `default` (the tiers, below) | none |
| `tools.<name>` | all | what the pack says of one tool of the source: `title`, `effect`, `call`, `untrusted`, `stepUp` | from the annotations or the method |

A source answers four questions (D96), each by declaration or by default, and the layers below the pack (the owner of a
space, then the person) can only narrow the answers:

| Question | Key | Answers |
|---|---|---|
| Where is it available | `availability` | `agent`, `personal`, `spaces` |
| Whose account its calls run with | `account.kind` | `none`, `agent` (credentials held by the deployment), `space` (a token the owner of each space sets) |
| Who may use it | `access` | roles, as the tiers below; the members of the space; guests only where the template says `guests: true` |
| What a call needs | `tools.<name>.effect`, `.call`, `.stepUp` | `none`, `confirm` (the person's card), `approval` (another person), and a step-up on top |

`account.kind: personal` and `organization` are reserved for phases 2 and 3 (each person's own accounts, the accounts
the organization opens): a pack that names either is refused at start, in words. A key `preset`, which would take a
source's type, connection and tool declarations from a connector the agent ships, is planned and not in this version.

### A full example

```yaml
identity:
  roles:
    employee: { description: Any home employee. }
    manager: { description: Approves sensitive actions., canApprove: true }
    sales: { description: The sales team. }
    comms: { description: The communication team. }
  roleRules: [ ... ]

approvals:
  approvers: [manager]                  # approve a tool of the whole agent or of Personal whose rule is approval
  confirmation: { timeoutSeconds: 300 } # how long a confirmation card waits

tools:
  sources:
    # An HTTP tool on the agent's account, in every conversation. Its one tool is named websearch.
    websearch:
      type: http
      title: Web search
      description: Searches the public web and answers the title, the link and a snippet of the first results.
      method: GET                       # effect read, rule none: nothing to declare under tools
      url: https://api.search.brave.com/res/v1/web/search?q={query}&count=5
      headers: { X-Subscription-Token: "${SEARCH_API_KEY}" }   # the agent's account, from a Secret
      parameters:
        type: object
        required: [query]
        properties: { query: { type: string, description: What to search for } }
      account: { kind: agent }
      availability: agent               # every conversation, Personal included
      untrusted: true                   # what it returns was written outside the organization
      access: { roles: { employee: ["*"] } }

    # An MCP server on a space's account: each Sales space binds its workspace and sets its own token.
    relaticle:
      type: mcp
      title: Relaticle CRM
      description: The sales team's accounts, contacts and notes
      transport: streamable-http        # a space account reaches a remote server only, never stdio
      url: https://crm.dev.ayni.org/mcp
      account:
        kind: space                     # set by the owner of each space, in the space's settings
        label: API token                # what the owner is asked for
        pattern: "^[A-Za-z0-9|]{20,200}$"
        apply: { header: Authorization, prefix: "Bearer " }
      availability: spaces              # in the spaces whose template names it
      offer: [list-companies, get-company, create-note, delete-note]
      bindings:
        - { name: workspace, label: Workspace, argument: workspace_id, pattern: "^[a-z0-9-]{1,64}$" }  # the owner's
        - { name: region, label: Region, value: eu }                        # fixed by the pack, a label on the cards
      access: { roles: { sales: ["*"] } }
      tools:
        list-companies: { effect: read, untrusted: false }
        get-company:    { effect: read, untrusted: false }
        create-note:    { title: Add a note, effect: write }    # confirm, by default
        delete-note:                    # no annotations: its effect is delete, its rule approval, by the space's owner
          stepUp: { authChallenge: { type: device } }           # then the phone of the person who asked

    # An MCP server on a space's account: one X account per space, named by a binding the agent pins.
    x:
      type: mcp
      title: X
      description: Posts, replies and mentions of the X account of the space
      transport: streamable-http
      url: https://x-mcp.dev.ayni.org/mcp
      account:
        kind: space
        label: Key of the X account
        apply: { header: X-Account }    # the token, as it is, in the header X-Account
      availability: spaces
      offer: [post_tweet, reply_to_tweet, get_mentions]
      bindings:
        - { name: account, label: X account, argument: account, pattern: "^@?[A-Za-z0-9_]{1,15}$" }   # the owner's
      untrusted: true                   # what it reads was written outside the organization
      access: { roles: { comms: ["*"] } }
      tools:
        post_tweet:     { title: Post on X, effect: external }    # an approval, by the space's owner
        reply_to_tweet: { title: Reply on X, effect: external }
        get_mentions:   { title: Read the mentions, effect: read }

    # Bundled tools: the agent's own records.
    workingMemory: { type: bundled, bundled: workingMemory, title: Memory }   # on by default; declared for its title
    stats:
      type: bundled
      bundled: statistics               # off until a source names it
      title: Statistics
      access: { roles: { manager: ["*"] } }

spaces:
  templates:
    - id: sales
      title: Sales
      kind: team
      creators: [manager]
      membership: { mode: list }
      tools:
        - { source: relaticle, add: auto }        # in every Sales space; its owner binds it and sets its account
    - id: comms
      title: Communication
      kind: team
      creators: [comms]
      membership: { mode: list }
      tools:
        - { source: x, add: owner, guests: false } # offered; the owner adds it, binds the X account, sets its key
```

Two sources may each have a tool of one name, a `delete` for instance: their `tools.delete` are two declarations, each
with its own rule and step-up, and when two MCP servers list one name the model is given `<id>__<name>` for each.

### Who may use a tool: `access` and the tiers

Every `(role, tool)` resolves to one tier from the `access` of the tool's source; availability, the state of a tool in a
space, its owner's rules and the membership only narrow what the roles give (TOOL-AVAIL-005):

| Tier | How the source's `access` declares it | Behavior |
|------|----------------------|----------|
| ALLOW | the tool in `roles[role]` (or `"*"`, or `default: all`) | the model sees the tool |
| APPROVAL | the tool in an `approval[]` entry and in the role's set | the model sees the tool; its rule is `approval`, by that entry's approvers |
| REQUESTABLE | the tool in an `elevation[]` entry and not in the role's set | hidden until an elevation grant is active |
| DENY | otherwise | never available |

`access` has the same shape in every source and names that source's tools only: an HTTP tool's own name, a bundled
tool's tools, an MCP server's tools (checked at discovery, not at start). `"*"` in a role's list allows every tool of the
source. `approval[]` entries name `tools`, `approvers` (declared roles with `canApprove`), optional `timeoutMinutes`,
`policy` (`count` or `percentage`, `vetoOnRefusal`), `approverConnectionType` and `attested`. `elevation[]` entries add
`purposes` (ids from the top-level `purposes`) and `grantTtlMinutes`. Defaults for all of them come from `approvals`.

A source with no `access` denies its tools to every role, but for the bundled tools that act on the person's own
records (`principalCredentials`, `requestPresentation`, `credentialIssuance`, `principalPreferences`, `workingMemory`, and
`knowledge_search`, `set_reaction_policy` and `email_check`, which no source names): every Principal may use those until
their source declares an `access`.

### The effect and the rule of a tool

A tool's **effect** is `read`, `write`, `delete` or `external` (posting or sending outside the organization). The pack
may declare it (`tools.<name>.effect`); otherwise it comes from the MCP annotations, an annotation the server leaves out
taking MCP's default (`readOnlyHint` false, `destructiveHint` true, `openWorldHint` true): `read` when `readOnlyHint` is
true, else `delete` when `destructiveHint` is true, else `external` when `openWorldHint` is true, else `write`. An HTTP
tool's comes from its method (`GET` read, `DELETE` delete, the others write). A tool with no annotations is therefore a
delete until the pack says otherwise. A bundled tool has no effect.

A tool's **rule** is, in this order: `approval` with that entry's approvers when an `access.approval` entry of its source
lists it; else the rule the pack declares (`tools.<name>.call`); else the default of its effect (read: `none`; write:
`confirm`; delete and external: `approval`); `none` for a bundled tool. In a space, the owner may make a rule stricter
(`none`, `confirm`, `approval`, `off`), never looser; the rule that applies is the strictest of the two.

A call then goes through, in order: the person's **confirmation** (a card in the conversation with the exact action,
every argument whole, Allow, Refuse and "Allow for this conversation"); the **approval** (a tool of the whole agent or
of Personal: the roles of its source's `access.approval` entry, else `approvals.approvers`, else the call is refused as
`no-approver`; a tool of a space: the space's owner, on the phone as an attested `authorize` flow and in a card); the
credential's **liveness** (`stepUp.maxCredentialAge`); the **step-up** (`stepUp.authChallenge`); the **call**, with the
pinned arguments set by the code and the account opened for it.

A source may be `untrusted`, and so may each of its tools (`tools.<name>.untrusted`, which wins); otherwise an MCP tool
is untrusted unless its `openWorldHint` is false, and an HTTP tool is trusted; a bundled tool always is. In a turn in
which a tool of an untrusted source returned a result, every later call of a tool whose effect is not `read` asks the
person's card, whatever its rule, with no "Allow for this conversation".

### The step-up of a tool

`tools.<name>.stepUp` is what the person proves before that tool of that source runs, and nothing else's (TOOL-CAT-010):

```yaml
tools:
  sources:
    payments:
      type: mcp
      transport: streamable-http
      url: https://payments.example/mcp
      access: { roles: { finance: [issue_refund] } }
      tools:
        issue_refund:
          stepUp:
            authChallenge: { type: face-match, onChannelUnavailable: fail, referenceImage: badge-photo }
            maxCredentialAge: 0
```

- `authChallenge.type`: `device` (a `confirm` flow on the person's phone, or a question-answer on another wallet; the
  device requires local authentication to be used), `face-match` (a call joined by the face-verification service, the
  badge photo as reference; needs `media.faceVerification`), `document` (NFC read). `onChannelUnavailable` is `fail`
  (default) or `degrade`; `timeoutSeconds` 30 at least. The email code belongs to the badges of the user directory and
  to no tool.
- `maxCredentialAge`: seconds of accepted staleness for the credential-liveness verdict before this tool runs; `0`
  forces a fresh check; absent means the session TTL `N`.

### Bundled tools

| `bundled` | The model's tools | On while no source names it |
|---|---|---|
| `principalCredentials` | `principal_credentials` | yes |
| `requestPresentation` | `request_presentation` (when the pack authenticates or asks a credential on demand) | yes |
| `credentialIssuance` | `credential_requirements`, `issue_credential` (when the pack issues) | yes |
| `principalPreferences` | `principal_preferences` | yes |
| `workingMemory` | `working_memory` | yes |
| `statistics` | `statistics` (`endpoint`, `defaultStatClass`) | no |
| `generateImage` | `generate_image` (`provider`, a `media.imageGeneration` provider; needs `features.imageGeneration`) | no |

A source names a bundled tool by `bundled`, and its id may differ (`notes: { type: bundled, bundled: workingMemory }`);
one source per bundled tool. Declaring it turns it on (`enabled: false` turns it off) and gives it a `title`, an
`availability`, an `access`, and, per tool, a stricter `call` and a `stepUp`; never an `account`, `bindings`, an
`effect` or `untrusted`. `knowledge_search`, `set_reaction_policy` and `email_check` follow their features and are
sources of their own name.

### Bindings and accounts

`bindings` are the parameters the agent pins: each has a `name`, a `label` people read, an optional `pattern`, an
optional `value` and an optional `argument`, the input argument it fills (and the `{argument}` placeholder of an HTTP
tool). The pinned argument is out of the input schema the model receives, and the code sets it on every call in place
of anything the model gives. A source of availability `agent` or `personal` gives every binding its `value`; in a source
of `spaces`, a binding the pack gives a value keeps it in every space, the others take theirs from each space's owner.

A `space` account is a token the owner types in the space's settings (`PUT {sessions}/spaces/{id}/tools/{source}/account`)
and nowhere else; it is sealed as it arrives under a key of its own, opened in memory for a call only, sent as
`account.apply` says (the header, after its `prefix`), never logged, never given to the model or to a client; a result
that echoes it reads `[account]`. One connection per space account of an MCP server, closed after
`TOOL_CONNECTION_IDLE_SECONDS` (600) unused. A change of a space's tools that grants something waits for the owner's
phone for `TOOL_CHANGE_CONFIRMATION_SECONDS` (300).

### Refused by the loader

- `mcp.servers`, `tools.http`, `tools.bundled`, `tools.access` and `actions`, in words and before the schema, each with
  the key that replaces it: `tools.sources.<id>` with `type: mcp`, `http` or `bundled`, the source's `access`, and
  `tools.sources.<id>.tools.<tool>.stepUp` (TOOL-CAT-011);
- a source with no `type` or an unknown one; an unknown `availability`, `account.kind`, `effect`, `call`, `bundled` or
  template `add`, naming the source and the field (TOOL-CAT-001); a key of another type's connection (an HTTP tool with
  `transport`), named by the schema; `account.kind: personal` or `organization` (TOOL-CAT-002);
- an HTTP tool whose `tools` names another tool than its own; a bundled tool named by two sources, or whose `tools` names
  a tool it does not give, or declares an `effect` or `untrusted`;
- an `account` on a bundled tool; a `space` account without `label` or `apply`; label, pattern or apply on an account that
  is not a space's (TOOL-CAT-002);
- a `space` account of an availability other than `spaces`, or on a `stdio` server (TOOL-AVAIL-003);
- a binding of a source of availability `agent` or `personal` without a `value`; a value that does not match its
  pattern; a pattern that is not a regular expression (TOOL-CAT-004/005);
- a template tool that names an id that is not a key of `tools.sources`, or a source of another availability
  (TOOL-AVAIL-002);
- an `access.approval` entry in a source of availability `spaces`, whose owner approves its tools (TOOL-CAT-009);
- a role of `approvals.approvers` that is not declared or has no `canApprove`;
- a step-up with the email code (INTX-AUTH-011), or a face match without `media.faceVerification`.

Warned at start: a source of `spaces` that no template names, and a tool whose rule the pack sets to `approval` with no
role to approve it (its calls are refused as `no-approver`; the same is warned at discovery when the annotations set it).

MCP servers connect lazily by default.

## purposes and approvals

`purposes` is the closed, governance-defined list a principal may declare when requesting an
out-of-role tool (D15). `permittedRoles` optionally restricts who may declare a purpose. The model
never declares a purpose and never approves. `approvals` holds the defaults: timeout, policy,
`selfApproval` (a requester who is also an eligible approver runs without a prompt) and the default
grant duration; `approvers`, the roles that approve a tool of the whole agent or of Personal whose rule is `approval`
and that no `access.approval` entry of its source lists (TOOL-CAT-009); `confirmation.timeoutSeconds`, how long a
confirmation card waits (300 by default, TOOL-CALL-004).

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

## conversations

`conversations.messageDeletionWindowSeconds` (600 by default) is how long a person may delete a message they
wrote: with it go the agent's reply to it (its messages, the tool calls and the memory lines of the turn that
answered it) and the memories the agent took from it, at once and on every device; a reply still being written is
cancelled first (PRIV-ERASE-010..012). `0` turns deletion off: the descriptor then declares no `erasure`. After the
window the message stays; an operator erases through the admin interface, which respects legal hold. A person
cannot delete a conversation.

```yaml
conversations:
  messageDeletionWindowSeconds: ${MESSAGE_DELETION_WINDOW_SECONDS:-600}
```

## spaces

A space holds one piece of work in the agent: a title, a purpose, a brief, a language and its rules (ayni-spec D80,
D84). Every conversation, and every entry of it, belongs to exactly one space; the default is the person's
**Personal** space, which everyone has without its being declared (SPACE-DEF-002). People who hold a role create the
others from the templates of `spaces.templates` (SPACE-DEF-003):

```yaml
spaces:
  personal:                             # the rules of every Personal space
    retentionDays: ${RETENTION_HISTORY_DAYS:-365}
    # lawfulBasis: the one of conversation-memory by default
    # allowedProviders: [<llm.providerName>] by default
  templates:
    - id: project                       # lowercase letters, digits and dashes
      title: Project
      kind: team                        # team or organization
      creators: [employee]              # the roles of who may create one
      membership: { mode: list }        # a list kept by the owner
      rules:
        retentionDays: { default: 365, min: 30, max: 1825 }
        lawfulBasis: { default: contract, allowed: [contract, consent] }
        allowedProviders: { default: [kimi], allowed: [kimi, anthropic] }
        handover: { default: true, allowed: [true, false] }
    - id: rotterdam
      title: Depot Rotterdam
      kind: team
      creators: [manager]
      membership: { mode: rule, rule: { department: Depot Rotterdam } }
    - id: everyone
      title: Northwind Logistics
      kind: organization                # always the rule organization: true
      creators: [manager]
      membership: { mode: rule, rule: { organization: true } }
```

- **Membership** is a list the owner keeps (`mode: list`), or a rule over verified facts of the people of the
  agent's own organization (`relation: home`): exactly one of a `department`, a `group`, or the whole
  `organization`. A member list is a share, never a role: no role makes anyone a member (SPACE-MEMB-003). The owner
  is always a member. Someone a rule no longer matches, or the owner removes from a list, is `left`: they keep
  reading their own conversations of the space, and run nothing in it (`409 space-left`).
- **Rules** have a default and the bounds an owner may change them within: `min` and `max` days for the retention,
  the `allowed` values of the others. A rule with no bounds keeps its default. `retentionDays` (365 by default): the
  entries of the space's conversations older than this are archived, never an entry on legal hold (PRIV-RETN-008).
  `lawfulBasis` defaults to the one of `conversation-memory`. `allowedProviders`, as `llm.providerName` names a
  provider, defaults to the agent's own: in a space that does not allow it the agent's code answers, with no model
  call (SPACE-CONV-004). `handover` lets an author share a conversation with the members of its space, read-only; it
  is off by default, and Personal takes none.
- Personal's rules are `spaces.personal`; without it, 365 days (the deployment's `RETENTION_HISTORY_DAYS`), the
  lawful basis of `conversation-memory` and the agent's provider.
- The title, the purpose and the brief of a space are stored sealed, like a conversation's title (D77).
- **People of other organizations (D90; decision 62).** The owner of a list space finds an organization in the trust
  graph (`GET {sessions}/organizations?q=`, the Verana Graph of `VERANA_GRAPH_URL`, the agent's own excluded) and
  invites a person of it by email (`POST {sessions}/spaces/{id}/members { organizationKey, email }`). The agent refuses
  an organization the graph does not hold trusted (`422 not-on-verana`), its own (`422 home-organization`), one whose
  badges `identity.authentication.issuers.organizations` does not accept (`409 organization-not-accepted`), and every
  invitation without an SMTP server (`503 email-unavailable`). The email names who invites, the space, the agent and
  its organization, says that a badge of that organization carrying the address is needed, and carries the app link to
  the agent (`<APP_LINK_BASE>service/<did>`): no token, nothing that opens the space. The invitation binds to the first
  person who presents a badge whose issuer is that organization and whose `email` is that address; they are then a
  `guest` of the space. A person the agent knows already is compared on the email their stored evidence holds, and
  asked nothing; one whose evidence holds none is asked once for their badge again. For this the authentication should
  ask for and store `email`, which the agent says at start when a list template exists and it does not.
- **Tools (D98; tools, phase 1).** A template's `tools` names the sources of availability `spaces` its spaces may use:
  `add: auto` puts one in every space of the template from its creation (and, for a space created before the template
  named it, from the next start), `add: owner` (the default) offers it to each owner; `guests: true` opens it to people
  of other organizations. In a space a source is `available`, `setup` (a binding without a value or its account not
  set), `ready` (its tools reach the model) or `off` (an `add: auto` one its owner removed). The owner manages them on
  the web and on the phone (`{sessions}/spaces/{id}/tools`, profile §3.10); a change that grants something (adding,
  binding, setting the account, loosening a rule) waits for the owner's phone, a `confirm` flow whose code the screen
  shows; a change that only narrows applies at once. A source the template no longer names leaves its spaces at the next
  start, its account's key destroyed. Personal takes no tool from a template.

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
2. Every role named in `roleRules`, `perActorOverrides`, a source's `access.roles`, `approvers`,
   `purposes[].permittedRoles`, `persona.menu[].roles` and `spaces.templates[].creators` is declared in
   `identity.roles`.
3. Every role in an `approvers` list has `canApprove: true`.
4. Every id in a source's `access.elevation[].purposes` exists in `purposes`.
5. The tool names of a source's `access` are tools of that source (an HTTP tool's own, a bundled tool's; an MCP
   server's are checked at discovery and logged, not refused at start); `persona.menu[].action.tool` names an HTTP or
   bundled tool, unless the pack has an MCP server.
6. A `stepUp.authChallenge.type: face-match` requires `media.faceVerification`.
7. `features.rag` requires `rag`; `features.voiceNotes` requires `media.speechToText`;
   `features.inboundImages` requires `media.vision`; `features.imageGeneration` requires
   `media.imageGeneration`.
8. The `provider` of the source that names `generateImage` is a `media.imageGeneration.providers[].name`.
9. `channels.agui.walletLinkTemplate` starts with `https://` and contains `{oob}`.
10. `memory.contextWindowTokens` plus `llm.maxOutputTokens` fits in `llm.maxInputTokens` when it is set (MEM-CTX-006).
11. A `partner-shared` RAG source names its `partner`, and only a `partner-shared` source names one (MEM-RAG-005).
12. A space template is declared once; its `creators` are declared in `identity.roles` (rule 2); the default of
    each of its rules lies within its bounds; a template of kind `organization` has the rule `organization: true`
    (SPACE-DEF-003).
13. A badge from the user directory: see `issuance`, "Refused by the loader" (IDENT-DIR-002/003, INTX-AUTH-011/012/015,
    INTX-ISSUE-020). A profile that takes nothing from the directory declares at most one challenge, never `email`.

14. The tool catalog: see `tools: the catalog of tool sources`, "Refused by the loader" (TOOL-CAT-001..011,
    TOOL-AVAIL-002/003).

Before the schema, a role that declares `crossSession` is refused in words (RBAC-XSESS-005), and so are the keys
`tools.sources` replaced (`mcp.servers`, `tools.http`, `tools.bundled`, `tools.access`, `actions`, TOOL-CAT-011), a
step-up that declares the email code (INTX-AUTH-011), a kind of account of a later phase (`personal`, `organization`,
TOOL-CAT-002), and a source of the catalog with no type or an unknown value (TOOL-CAT-001).

## Differences from the previous generation of packs

For readers of the earlier `hologram-ai-agent` packs: `languages` (per-language prompts) is replaced by
one `language.agent` and the frontend's presentation language; `flows.authentication`
(credential definition ids, roles attribute, admin users) is replaced by `identity` (Verifiable Trust
resolution, role rules over verified facts, no admin bypass); `accessMode: user-controlled` and
`userConfig` are gone (deployment-held credentials, and from tools phase 1 a space's account set by its owner in the space's settings); `imageGeneration`, `speechToText` and
`vision` moved under `media`; `integrations` is gone (deployment values are environment variables);
`privacy`, `purposes`, `sessions`, `channels`, `integrity` and `features` are new; MCP servers, HTTP tools and bundled
tools are one map, `tools.sources` (ayni-spec D101).
