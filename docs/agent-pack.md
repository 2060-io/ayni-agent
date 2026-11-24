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
| `identity` | yes | the agent's DID, user-agent gate, the authentication (methods and combinations), organization patterns, roles, role rules, per-actor overrides, the file of the user directory | D30, D34, D37, D38, D79 |
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
| `admin` | with `auditor` or `operator` | the methods Show Admin asks on the phone, the minutes of an admin grant, the internal admin interface | D132 to D134, RBAC-ADMIN |
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
  authentication:                             # how a person authenticates, on the phone only (D125, D128)
    request: on-connect                       # or on-demand: nothing is asked at connection
    visitors: false                           # true: the person may continue as a visitor (with on-connect)
    methods:                                  # by a name the operator chooses; the type says what it is (D126)
      badge:
        type: credential
        credential: { jsonSchemaCredentialId: https://.../vt/schemas-badge-jsc.json }
        subjectKey: [badgeNumber]
        issuers: { organizations: ["org:EE:14000000"] }   # whose credentials are accepted; any issuer when absent
        attributes: [badgeNumber, name, title, department]
        store: { attributes: [name, title, department], retention: { days: 365, onExpiry: erase } }
        modelVisible: [name]
      email:    { type: email }               # a code sent to an address of the user directory
      passport: { type: document }            # the chip of a passport or an identity card, matched to an entry
      face:     { type: face-match, reference: [document, directory] }   # confirms; consent is its lawful basis
      otp:      { type: authenticator-app }   # confirms; enrolled on the phone
      passkey:  { type: passkey }             # enrolled on the phone
    combinations:                             # the accepted combinations; each holds an identifying method
      - [badge]
      - [passport]
      - [email, otp]
      - [passkey]
    obtain: { text: "Ask your front desk for your badge.", url: https://.../badge }   # how to obtain what is lacking
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
    auditor:         { description: Reads what Audit serves. }   # with admin.authentication (see "admin")
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
- **`authentication`** (D125 to D131, IDENT-AUTH-001) enables **methods**, each keyed by a name the operator
  chooses and given a `type`, and lists the **accepted combinations**, each a list of method names. A person is
  identified once every method of one accepted combination, which they choose on the phone, completed in one
  `authenticate` flow and the methods found one identity. Nothing of an authentication runs in a browser or in a
  conversation (D128): a wallet that takes no flows is asked a `credential` method that is a combination by itself, as a
  presentation request, and nothing else. An agent that authenticates nobody omits `authentication`, or lists no
  combination: everyone then enters unidentified. The types:

  | Type | What the phone does | Finds or confirms | Needs |
  |---|---|---|---|
  | `credential` | presents a credential of the method's schema (`credential.jsonSchemaCredentialId`) | finds the entry a badge this agent issued from its directory was issued from, else the person of the credential | `subjectKey` among the `attributes` asked |
  | `email` | the person types an address, then the code sent to it | finds the entry that holds the address | `identity.directory`, an SMTP server (`MAIL_HOST`, `MAIL_FROM_ADDRESS`) |
  | `document` | reads the chip of a passport or an identity card | finds the one entry whose names, birthdate and nationality it carries | `identity.directory` (its entries then carry `birthDate` and `nationality`) |
  | `face-match` | films the live face, after the person consents on the step | confirms the identity found, against `reference`: the passport read in the same flow, the entry's `photo` | `media.faceVerification`; the processing activity `biometric-matching` with the lawful basis `consent` |
  | `authenticator-app` | the person types the code of their authenticator app (TOTP) | confirms the Principal that enrolled it | an enrolment on the phone |
  | `passkey` | signs the agent's challenge with the passkey | finds the Principal that enrolled it | an enrolment on the phone |

  `credential`, `email`, `document` and `passkey` find an identity (**identifying**); `face-match` and
  `authenticator-app` only confirm one (**confirming**). The agent refuses to start on an unknown type, naming the
  method; on a combination that names a method not enabled, names one twice, is listed twice, or holds no identifying
  method; on a `credential` method without its schema or subject key; on a field of a credential (`credential`,
  `subjectKey`, `attributes`, `issuers`, `store`, `modelVisible`) on another type; on an `email` or `document` method,
  or a face match with the `directory` reference, without `identity.directory`; on a `face-match` method without
  `media.faceVerification` or with a basis of `biometric-matching` other than consent; and on an `email` method with no
  SMTP server. The passport alone (`[document]`) is accepted without a face match in this version (D127). A face match is
  offered only to a phone that disclosed `calls/1.0` as `callee`.
- **Who a person is** (IDENT-RES-002, IDENT-AUTH-003). A person of the user directory is
  `<home organization key>|directory|<entry id>`, whichever methods identified them; a Principal held before under the
  key of its badge, or that held the entry, keeps its conversations under the entry's key. A person identified by a
  credential of another organization is `<organization key>|<schema>|<subject key>`, the issuer taken from what the
  DIDComm agent verified in the proof, never from an attribute: the same badge number from another organization is
  another person, and a badge re-issued by the same organization is the same person, whichever of its services issued
  it. A presentation that leaves a `subjectKey` attribute unrevealed identifies nobody (`incomplete`). The Principal
  keeps the last authentication: when, why, the combination, each step's outcome, the entry found.
- **The steps** (flow profile §6.14). The identifying methods run first, in the order the combination lists them,
  then the confirming ones; each is announced by a `step` and ended by a `step-result`. An email step asks the address
  (ten minutes), answers the same whether or not an entry holds it, sends a code of six digits only to an address an
  entry holds, in the language of the phone's locale, kept as a keyed hash, valid ten minutes, five tries in all, up
  to three new codes thirty seconds apart, each replacing the one before. An authenticator app's step takes a code of
  the current thirty seconds or the ones around them, each once, five tries. A passkey's step signs a challenge of 32
  bytes for the network's app-link domain (`channels.agui.appLinkBase`, `APP_LINK_BASE`), the person verified, its
  counter going on. A face step asks the consent, then offers a call under the flow id that the face-verification
  service joins with the reference; nothing of the face is kept, only the audit fields of its evidence. A person who
  declines the consent ends the step `consent-declined`, with no call and nothing recorded, and chooses on the phone,
  in the same flow, another accepted combination that does not hold that method, within five minutes (D152); all its
  steps run, a method that passed before included.
- **Enrolling an authenticator app or a passkey** (D129). A pack that enables a method of either type lets an
  identified person add one from the service's menu on the phone (an `enrol` flow); the status of an identified person
  lists the types they may enrol and those they enrolled. The agent enrols only on a connection authenticated within
  the last ten minutes by a combination that holds neither, and otherwise first asks an authentication of purpose
  `enrol` with the combinations that hold neither; a visitor is refused. The authenticator app's secret is handed to
  the phone once and kept sealed; of a passkey the agent keeps its credential id and public key. One of each per
  Principal, the new one replacing the earlier; the person removes one from the phone; both are erased with the
  Principal's directory entry.
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
  stored to serve as the reference of a tool's face-match challenge (never of a `face-match` method, whose reference
  is a passport read in the same flow or the directory entry's `photo`). The `principal_credentials` tool lists the
  records with the visible attributes. An address verified by an email step, a document read and a face match of an
  accepted authentication are evidence too (`evidence.email`, `evidence.document` say what is kept of them; a face
  match keeps its audit fields only); nothing of an authentication that is not accepted is kept.

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
  (RBAC-XSESS-005/007): a role carries no scope of conversation reads. A conversation is read by its author, by the
  active members of its space once its author shares it with the space, and by an auditor through Audit (see
  `admin`). `canApprove` marks roles that may appear in `approvers`. `admin` lets the role read the admin view of
  roles and changes (IDENT-DIR-008, with the user directory).
- **Who enters unidentified follows from `authentication`, and from nothing else** (D53, D72). A pack that
  accepts no combination lets every wallet in, unidentified. One that accepts some is in one of three modes:

  | Mode | Pack | At connection |
  |---|---|---|
  | required | `request: on-connect` | the authentication is asked; nothing opens without it |
  | offered | `request: on-connect`, `visitors: true` | the authentication is asked; the person may continue as a visitor |
  | on request | `request: on-demand` | nothing is asked; the person enters as a visitor and authenticates when they ask |

  `on-demand` lets visitors in by itself: `visitors: false` with it is refused at start-up.
- **The request at connection** (D72, IDENT-RES-019/020). The `authenticate` flow is valid fifteen minutes, the time
  of every step; a choice that does not come within five minutes leaves it unanswered. An authentication that is not
  accepted is answered with its reason (`issuer-not-accepted`, `not-valid`, `incomplete` for a credential;
  `step-failed`, `step-expired`, `no-match` for another method; `different-identities` when the methods found different
  people) and asked again, with no limit: the person ends it by declining. A decline ends the connection when the
  authentication is required and lets the person in as a visitor when it is offered. No answer in time ends the
  connection in both. Nothing is open before the outcome, so no conversation exists before it; a person who
  authenticates finds their conversations.
- **Whose credentials are accepted** (D72). With no `issuers` on a `credential` method, the credential of any
  accredited issuer of the schema that an organization backs. With `issuers.organizations`, only the credentials whose
  issuer is one of those organizations, by organization key (`org:<country>:<register id>`). The agent decides this
  when it verifies the presentation; the phone is told the list, with the method, so that it offers no other.
- **How what is lacking is obtained** (D72). `obtain` is the operator's own text, with a link when there is one. The
  phone shows it to a person who can complete no combination, or whose authentication was not accepted.
- An unidentified person, a visitor, is a Principal
  without backing identity: relation `unrecognized`, `public` visibility only, the role rules decide the
  rest. The agent says at start-up that it admits unidentified peers. There is no separate setting: the
  earlier `unidentifiedPeers` and the `UNIDENTIFIED_PEERS` variable are gone (the variable is ignored, with
  a warning). `DEV_ALLOW_UNIDENTIFIED_PRINCIPALS` stays, for development only.
- **The wallet is told where it stands** (D71, D72). The same object gives the status message the agent sends
  on each connection: the rule, `none` with no accepted combination, `optional` when visitors are let in,
  `required` when they are not; the methods, a `credential` method with its schema and the organizations it accepts
  when it lists any; the accepted combinations; how what is lacking is obtained, when the pack says it; and, to an
  identified person, the types they may enrol and those they enrolled. The message also says whether the person is
  identified and what is open to them, so the app knows whether to wait for the request, and when it may open the
  conversation. Nothing else is configured for it.
- **Authenticating later** (D65, D66, D72). While a connection is unidentified, the authentication is asked when
  the person asks from their wallet (the Ayni app's **Authenticate**, in the service's menu, which needs no
  conversation), when the person picks **Authenticate** in the agent's own menu (sent to the web UI and to
  other clients, not to the Ayni app), or when the model calls `request_presentation` with the entry
  `authentication` (the tool exists for an unidentified person only, takes nothing else, and answers with
  a status). A request made this way, declined or left unanswered, changes nothing: the person stays a
  guest. The agent does not insist: one request at a time on a connection (the DIDComm agent keeps one
  `authenticate` flow open at a time), and after a request that was declined or left unanswered the model waits ten
  minutes; the person's own request is always served. An accepted authentication upgrades the connection to the
  Principal it identifies, and the conversations held before, with their sessions and entries, move to it; working
  memory and preferences of the visitor are not merged. A connection that is already identified accepts an
  authentication of the same person only: another identity is refused on the flow (`another-identity`), nothing of it
  is kept and nothing is asked again. Issuing a credential never identifies: the person authenticates.
- `userAgentGate: optional` lets wallets that do not present an ECS-UserAgent credential connect; the
  Principal is then marked `userAgentVerified: false`, which `roleRules` may use.
- `credentials` names the other credentials the agent requests on DIDComm connect (IDENT-RES-001/003):
  `userAgent` (the ECS-UserAgent credential of the gate) and `service` (credentials accepted from a
  verifiable-service peer). Each entry is a `jsonSchemaCredentialId` or a `credentialDefinitionId`
  the DIDComm agent can resolve, with optional `attributes`. The credentials that authenticate a person are the
  `credential` methods of `authentication`, above; `credentials.badge` no longer exists.

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
    birthDate: 19910521           # YYYYMMDD; only when a passport is read: a document method, or badges from a passport
    nationality: ESP              # the code of ICAO Doc 9303; idem
    photo: p-0042.jpg             # optional: the reference of a face-match method, a JPEG or PNG file beside this one
    department: Depot Rotterdam   # optional: rule spaces only
    groups: [fleet-safety, night-shift]      # optional, several: rule spaces only
    roles: [dispatcher]           # typed by hand, roles of identity.roles
```

- **Validation.** Every scalar is read as text (an id `0042` keeps its zeros). Ids and emails are unique, roles are
  declared, no other field is allowed, and a birthdate and a nationality are required on every entry when the
  authentication has a `document` method or an issuance profile obtains badges from the directory with a passport. A
  `photo` names a file in the folder of the directory file by its name alone, read when a face match needs it and at no
  other time (IDENT-DIR-010); it is never served, logged or given to a model. At start a file that does not validate stops the agent,
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
  three lists `attributes`, `store` and `modelVisible`, exactly as for a `credential` method of the authentication. It never
  binds a Principal: only the authentication does. The issuer is the one the DIDComm agent verified in the
  proof; a presentation whose record reports no issuer is not evidence.
- The model gets a status: `verified`, or `not presented` when the request was declined or left
  unanswered, which says nothing about whether the credential is held. After that the model waits ten
  minutes before the same entry can be asked again; one request is pending on a connection at a time.
- The name `authentication` is reserved: it is the entry of the authentication, which the same tool offers to an
  unidentified person (on the phone, in an `authenticate` flow); `face-match` is the entry of a face match's evidence.

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
| `transport`, `url`, `command`, `args`, `env`, `headers` | `mcp` | the connection: `stdio` needs `command`, `sse` and `streamable-http` need `url`; `headers` and `env` hold the agent's account as placeholders; the agent connects on first need and again after a drop (TOOL-MCP-003) | none |
| `description`, `method`, `url`, `headers`, `parameters`, `bodyTemplate`, `timeoutSeconds` | `http` | the request: `description` is what the model reads of the tool (required), `parameters` the JSON Schema of its arguments, `{param}` placeholders in `url` and `bodyTemplate` | `timeoutSeconds: 30` |
| `bundled`, `enabled` | `bundled` | the bundled tool it names (below), and `enabled: false` to turn off one that is on by default; `endpoint` and `defaultStatClass` for `statistics`, `provider` for `generateImage` | `enabled: true` |
| `title`, `description` | all | what people read on the cards, in the sources and in a space's settings | the id; none |
| `account` | `mcp`, `http` | whose account its calls run with: `none`, `agent`, `space`, `personal` (below) | `agent` |
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
| Whose account its calls run with | `account.kind` | `none`, `agent` (credentials held by the deployment), `space` (what the owner of each space sets, one field per key: `account.fields`, `account.apply`), `personal` (each person's own, which the person connects: `account.oauth`, or `account.fields` and `account.apply`, or `account.from`) |
| Who may use it | `access` | roles, as the tiers below; the members of the space; guests only where the template says `guests: true` |
| What a call needs | `tools.<name>.effect`, `.call`, `.stepUp` | `none`, `confirm` (the person's card), `approval` (another person), and a step-up on top |

`account.kind: organization` is reserved for phase 3 (the accounts the organization opens): a pack that names it is
refused at start, in words. `personal`, each person's own account, is phase 2 (ayni-spec D104 to D110), below. A key
`preset`, which would take a source's type, connection and tool declarations from a connector the agent ships, is
planned and not in this version.

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

    # An MCP server on a space's account of a single token: each Sales space binds its workspace and sets its own token.
    relaticle:
      type: mcp
      title: Relaticle CRM
      description: The sales team's accounts, contacts and notes
      transport: streamable-http        # a space account reaches a remote server only, never stdio
      url: https://crm.dev.ayni.org/mcp
      account:
        kind: space                     # set by the owner of each space, in the space's settings
        fields:                         # a single token is one field
          - { name: token, label: API token, pattern: "^[A-Za-z0-9|]{20,200}$" }
        apply:                          # sent after Bearer, in the header Authorization
          - { header: Authorization, value: "Bearer {token}" }
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

    # An MCP server on a space's account of four keys: one X account per space, named by a binding the agent pins.
    x:
      type: mcp
      title: X
      description: Posts, replies and mentions of the X account of the space
      transport: streamable-http
      url: https://x-mcp.dev.ayni.org/mcp
      account:
        kind: space
        fields:                         # one or more; the order is the order shown
          - { name: api_key, label: API key, pattern: "^[A-Za-z0-9]{10,64}$" }
          - { name: api_secret, label: API secret, pattern: "^[A-Za-z0-9]{20,128}$" }
          - { name: access_token, label: Access token, pattern: "^[0-9]{1,20}-[A-Za-z0-9]{10,64}$" }
          - { name: access_token_secret, label: Access token secret, pattern: "^[A-Za-z0-9]{20,128}$" }
        apply:                          # one or more headers; {name} is replaced by that field's value
          - { header: X-Account, value: "{api_key}:{api_secret}:{access_token}:{access_token_secret}" }
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
        - { source: x, add: owner, guests: false } # offered; the owner adds it, binds the X account, sets its keys
```

Two sources may each have a tool of one name, a `delete` for instance: their `tools.delete` are two declarations, each
with its own rule and step-up. When two MCP servers whose tools can be in one turn list or `offer` one name, the model
is given `<id>__<name>` for each, from the start and whether the other server is discovered yet or not; two sources
never in one turn (one of availability `personal` and one of `spaces`, as `github` and `github-project` below) keep
their names.

### Who may use a tool: `access` and the tiers

Every `(role, tool)` resolves to one tier from the `access` of the tool's source; availability, the state of a tool in a
space, its owner's rules and the membership only narrow what the roles give (TOOL-AVAIL-005):

| Tier | How the source's `access` declares it | Behavior |
|------|----------------------|----------|
| ALLOW | the tool in `roles[role]` (or `"*"`, or `default: all`) | the model sees the tool |
| APPROVAL | the tool in an `approval[]` entry and in the role's set | the model sees the tool; its rule is `approval`, by that entry's approvers |
| REQUESTABLE | the tool in an `elevation[]` entry and not in the role's set | the model sees the tool, whatever the grants, so that a grant leaves the start of the request as it was (D112); a call runs only while an elevation grant is active, checked in code at the call, and is refused (`not-granted`) otherwise |
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
`no-approver`; a tool of a space: the people its approval policy in the space names, below, each on the phone as an
`authorize` flow and in the Notifications); the
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
| `connections` | `offer_connection`, the Connect card of a person's own account (D108), given to the model only while the person has one to connect there | yes, while the pack declares a `personal` source |

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

A `space` account is what the owner types in the space's settings and nowhere else, one masked field for each of its
`fields` (ayni-spec D102):

| Key | What it says |
|---|---|
| `account.fields` | the fields the owner fills, one or more, in the order the settings show them: `name` (a lower-case letter, then lower-case letters, digits or `_`, 32 at most, unique in the account), `label` (what the owner is asked for) and an optional `pattern` its value must match; every field is a secret |
| `account.apply` | the headers each call carries, one or more: `header` and `value`, in which `{name}` stands for the value of that field. A value names declared fields only, and every field is named at least once |

A single token is one field:

```yaml
account:
  kind: space
  fields: [{ name: token, label: API token }]
  apply: [{ header: Authorization, value: "Bearer {token}" }]
```

and an API that takes several keys of one account in one header, as the X server takes the four keys of an X account,
asks for each in a field of its own and joins them in `apply`, as the `x` source above does. The owner sends them
together (`PUT {sessions}/spaces/{id}/tools/{source}/account` with `{ "values": { "<name>": "<value>", … } }`): every
field, and no other (`400 bad-request`, `field: "account.<name>"`); each value is trimmed of the whitespace at its ends,
as a paste often adds a line break, then refused with `422 bad-token` at its field when it is empty, longer than 4096
characters, has whitespace or a control character inside it, or does not match its pattern. The values are sealed
together as they arrive, as one record under a key of its own, opened in memory for a call only; the headers are built
from them then, never logged, never given to the model or to a client; a result that echoes a value, or a built header,
reads `[account]`. An account sealed before the fields (a single token of 0.27.0), or whose values no longer fit the
fields the pack declares, is dropped at start, and its owner sets it again. One connection per space account of an MCP
server, closed after
`TOOL_CONNECTION_IDLE_SECONDS` (600) unused. A change of a space's tools that grants something waits for the owner's
phone for `TOOL_CHANGE_CONFIRMATION_SECONDS` (300).

### Each person's own accounts

A source of `account.kind: personal` runs each call with the account of the person who asks, at the external service,
with that person's rights there (ayni-spec D104 to D110): the service, and not Ayni, decides what each person may read
and change. The person connects it, in **Your accounts** (a page of each agent, on the phone and on the web) or from a
**Connect card** the model shows in a reply; never in a conversation, never through the model, never from the pack.
Connecting asks nothing of the phone; disconnecting applies at once.

| Key | What it says |
|---|---|
| `account.oauth.client.registration` | how the agent obtains its client at the service's authorization server: `metadata-document` (its client ID metadata document at `{PUBLIC_BASE_URL}/tools/oauth/client-metadata.json` is the `client_id`; the server must say `client_id_metadata_document_supported`), `pre-registered` (a client the operator registered; `issuer`, `id` and `secret` from the deployment's secrets, used at that issuer only), `dynamic` (Dynamic Client Registration at the server's `registration_endpoint`, once, kept for the issuer). No fallback from one to another |
| `account.oauth.scopes` | the scopes asked; `[]` asks none. Absent: those of the server's `401` challenge, else of its Protected Resource Metadata, with `offline_access` when the authorization server lists it |
| `account.oauth.bindingRequest` | how the sign-in asks the service for the value of the account's binding (layer a of D110): `{ parameter: <name> }`, a parameter of the authorization request that carries the value, or `{ resource: <URL with {value}> }`, sent as the `resource` and used as the server's URL for that account |
| `account.fields`, `account.apply` | instead of OAuth, the fields of a personal API token, as a space's account declares them; the person types them in Your accounts |
| `account.from` | instead of either, the id of another source whose personal account this one uses, of the same type and at the same URL: one sign-in serves both |
| `account.binding` | the binding of the source whose value each account is for, such as Relaticle's workspace: a person holds one account per value, and a conversation uses the one for the value in force there |
| `account.check` | the read the agent makes once right after each connection, in code and outside the model: `tool` (a tool the source offers, of effect `read`, called with no argument), JSON pointers into its result (`binding.value`, `binding.label`, `email`) and a `label` in which `{/pointer}` stands for a value. A value of the binding other than the one expected, or an email other than the person's in the user directory, discards the tokens (revoked where the service allows it) |
| `account.tokenPatterns` | regular expressions that find a credential of the source in a message (a `space` or `personal` account): a message with a match of 16 characters or more is held back from the model whole (D109) |

The two demonstrations of phase 2, Relaticle CRM in the spaces of a Sales template and GitHub in Personal and in a
Project space:

```yaml
identity:
  directory: { file: /secrets/directory/directory.yaml }   # check.email compares with the person's entry

tools:
  sources:
    relaticle:                          # each member's own Relaticle account, for the space's workspace
      type: mcp
      title: Relaticle CRM
      description: The companies, people, notes and tasks of the space's workspace
      transport: streamable-http        # a personal account reaches a remote server, never stdio
      url: https://crm.2060.io/mcp
      account:
        kind: personal
        oauth:
          client: { registration: dynamic }          # Relaticle registers clients at /oauth/register
          bindingRequest: { parameter: workspace }   # the consent offers the space's workspace only, once Relaticle can
        binding: workspace              # each account is for one workspace: the space's
        check:                          # read once after the sign-in, before any call
          tool: who-ami-tool
          binding: { value: /workspace/id, label: /workspace/name }
          email: /user/email            # the account must carry the person's email of the directory
          label: "{/user/email} · {/workspace/name}"
      availability: spaces
      bindings:
        - { name: workspace, label: Workspace }      # no argument: the token reaches its workspace only
      offer: [who-ami-tool, list-companies-tool, get-company-tool, list-people-tool, create-note-tool]
      access: { roles: { employee: ["*"] } }
      tools:
        who-ami-tool:        { effect: read, untrusted: false }
        list-companies-tool: { effect: read, untrusted: false }
        get-company-tool:    { effect: read, untrusted: false }
        list-people-tool:    { effect: read, untrusted: false }
        create-note-tool:    { title: Add a note, effect: write, untrusted: false }   # confirm, by default

    github:                             # GitHub's remote MCP server, in Personal, with each person's GitHub
      type: mcp
      title: GitHub
      description: Code, issues and pull requests in GitHub
      transport: streamable-http
      url: https://api.githubcopilot.com/mcp/
      account:
        kind: personal
        oauth:
          client:
            registration: pre-registered            # github.com offers no registration endpoint and no documents
            issuer: https://github.com/login/oauth
            id: ${TOOLS_GITHUB_CLIENT_ID}           # the GitHub App of the organization
            secret: ${TOOLS_GITHUB_CLIENT_SECRET}
          scopes: []                                # a GitHub App's permissions decide
        check: { tool: get_me, label: "{/login}" }
        tokenPatterns: ["gh[pousr]_[A-Za-z0-9]{36,251}", "github_pat_[A-Za-z0-9_]{22,255}"]
      availability: personal
      offer: [get_me, search_repositories, get_file_contents, list_issues, issue_read, issue_write, add_issue_comment]
      untrusted: true                   # issues and files are written by anyone
      access: { roles: { employee: ["*"] } }
      tools:
        get_me:            { effect: read }
        issue_write:       { title: Open or change an issue, effect: write }
        add_issue_comment: { title: Comment on an issue, effect: write }

    github-project:                     # the same server, bound to the repository of a Project space
      type: mcp
      title: GitHub repository
      description: The issues of the project's repository
      transport: streamable-http
      url: https://api.githubcopilot.com/mcp/
      account: { kind: personal, from: github }     # the person's GitHub account: one sign-in serves both
      availability: spaces
      offer: [list_issues, issue_read, issue_write, add_issue_comment]
      bindings:
        - { name: owner, label: Organization, argument: owner, pattern: "^[A-Za-z0-9-]{1,39}$" }
        - { name: repo, label: Repository, argument: repo, pattern: "^[A-Za-z0-9._-]{1,100}$" }
      untrusted: true
      access: { roles: { employee: ["*"] } }
      tools:
        issue_write:       { title: Open or change an issue, effect: write }
        add_issue_comment: { title: Comment on an issue, effect: write }

spaces:
  templates:
    - { id: sales, title: Sales, kind: team, creators: [manager], membership: { mode: list },
        tools: [{ source: relaticle, add: auto }] }       # its owner binds the workspace from an account of their own
    - { id: project, title: Project, kind: team, creators: [manager], membership: { mode: list },
        tools: [{ source: github-project, add: auto }] }  # its owner binds the repository
```

How it works:

- **The sign-in** (OAuth as MCP defines it, revision 2026-07-28): `POST {sessions}/connections/{source}/authorize` finds
  the server's authorization server through its Protected Resource Metadata, reads that server's metadata (its issuer
  checked, `S256` required), obtains the client the source declares, and answers the URL of the sign-in, which carries
  PKCE `S256`, the `state` of a single-use attempt of `TOOL_OAUTH_ATTEMPT_SECONDS` (600), the server's `resource` and the
  scopes. The service sends the browser back to `{PUBLIC_BASE_URL}/tools/oauth/callback`, where the agent checks the
  `iss` of the answer, exchanges the code with the verifier and the `resource`, makes the `check`, seals the account,
  and sends the browser on to `{APP_LINK_BASE}service/{did}/accounts`, with nothing of the outcome; the person's sessions
  hear it as `ayni.connections.changed`. Both paths must reach the agent from the internet (its ingress).
- **Keeping it:** each person's key, wrapped by `ENTRY_ENCRYPTION_KEY`, wraps the key of each of their accounts, under
  which the tokens or the values and the label are sealed. Ending a person's access (their entry leaves the directory)
  destroys their key, and every account with it. A token is opened only for a call of its person or a refresh, sent only
  in `Authorization` to the source's own server, never logged; an echo of it in a result reads `[account]`.
- **Its life:** a token that expires within a minute is refreshed before the call, and once more after a `401`, one
  refresh at a time per account, the rotated refresh token kept. A refused refresh puts the account to reconnect; a `403
  insufficient_scope` marks it as asking for more access. At start, an account whose source the pack no longer offers as
  it did (its URL, registration, client id, issuer or binding changed) ends; one whose `scopes` changed must reconnect.
- **What the model knows:** one line per personal source the person can use there and has not connected, in the record
  of the person at the start of their latest message (D112), and `offer_connection` to show its Connect card. Its tools
  come once the account is connected.
- **In a space** a source of `personal` is added and bound by the owner, who sets no account (`PUT …/account` answers
  `409 no-space-account`); the value of the binding the account is for comes from an account of the owner's own, never
  typed by hand (`422 not-your-account` otherwise), and is confirmed on the owner's phone as any binding is.

### Refused by the loader, for each person's own accounts

- a `personal` account that declares none, or more than one, of `oauth`, `fields` and `apply`, and `from`, naming the
  account; `oauth` on an HTTP tool; a personal account on a `stdio` server; `headers.Authorization` beside `oauth`
  (TOOL-CAT-013, TOOL-AVAIL-007);
- a `registration` other than the three; a `pre-registered` client whose `issuer` or `id` is missing or empty once its
  placeholders are resolved; `issuer`, `id` or `secret` with another registration; a `bindingRequest` without a
  `binding`, or a `resource` without `{value}` (TOOL-CAT-014);
- a `from` that names an unknown source, a source of another kind of account, one that itself declares `from` or
  `binding`, or one of another type or at another URL; a `binding` or a `check` on a source of `from` (TOOL-CAT-015);
- a token pattern that does not compile (TOOL-CAT-016);
- a `check.tool` the source does not offer or whose declared effect is not `read`; a pointer that is not one; a
  `binding` that names no binding of the source, or comes without `check.binding`; `check.email` in an agent with no
  user directory (TOOL-CAT-017);
- `oauth`, `from`, `binding` or `check` on an account that is not `personal`; `tokenPatterns` on one that is neither a
  space's nor a person's.

### Refused by the loader

- a source with no `type` or an unknown one; an unknown `availability`, `account.kind`, `effect`, `call`, `bundled` or
  template `add`, naming the source and the field (TOOL-CAT-001); a key of another type's connection (an HTTP tool with
  `transport`), named by the schema; `account.kind: organization` (TOOL-CAT-002);
- an HTTP tool whose `tools` names another tool than its own; a bundled tool named by two sources, or whose `tools` names
  a tool it does not give, or declares an `effect` or `untrusted`;
- an `account` on a bundled tool; a `space` account without `fields` or `apply`; `fields` or `apply` on an account that
  is neither a space's nor a person's; two fields of one name, a field's pattern that is not a regular expression, a header declared twice,
  a header's value that names a field the account does not declare, and a field no header names (TOOL-CAT-002, D102);
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

**The tools of spaces** (D137 to D140, TOOL-CAT-023). A tool of a space whose rule is `approval` is approved as its
**approval policy** in that space says, which the space's owner sets within the bounds of `approvals.spaces`; until the
owner sets one, the tool takes `default`:

```yaml
approvals:
  spaces:
    default:                           # none: the owner, required, 1 approval, any refusal, attested, own confirmation
      approvers: [{ kind: owner, required: true }]   # owner, member, role (with role), department (with department)
      threshold: 1                     # approvals in total, required ones included
      refusal: any                     # any: one refusal rejects; required: only a required approver's
      attested: true                   # each decision on the phone
      whenApproverAsks: own-confirmation   # or another-approver: the default with two approvers or more
    minApprovals: 1                    # the least threshold an owner may set
    allowedApprovers: { kinds: [owner, person, member, role, department], roles: [manager] }
    attested: optional                 # required: no policy turns attestation off
    timeouts:                          # minutes, per kind of approval; each space's owner sets its own within
      tool-call: { default: 60, min: 5, max: 10080 }
tools:
  sources:
    x:
      tools:
        post_to_x:
          approval:                    # tighter for this tool; `default` gives the fields it changes
            minApprovals: 2
            default: { approvers: [{ kind: owner, required: true }, { kind: role, role: manager, required: false }], threshold: 2 }
```

An agent-pack names no person: an owner names people of the space (`person`). A requester never counts toward their own
request; with `own-confirmation` an approver who asks confirms on their own phone, always attested. A looser policy waits
for the owner's phone, a stricter one applies at once. Refused at start, naming the field: a default outside its bounds
(as `minApprovals: 2` with a threshold of 1), a `person` entry, a role not declared or without `canApprove`, and a
timeout's `default` outside its `min` and `max`.

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
window the message stays; a holder of the role `operator` erases through Operations (see `admin`), which respects
legal hold. A person cannot delete a conversation.

```yaml
conversations:
  messageDeletionWindowSeconds: ${MESSAGE_DELETION_WINDOW_SECONDS:-600}
```

## admin

Admin access to the raw store (D132 to D134, RBAC-ADMIN-001 to 008, RBAC-XSESS-006 to 009): no port-forward and no
typed name. It is served through the AG-UI profile (§3.14) to the web UI and the Ayni app alike.

**The two roles** (RBAC-XSESS-008). `auditor` reads what Audit serves: the conversations of any person, decrypted, by
person, space and period, the evidence records, the call records of the tools and the admin audit; it writes nothing.
`operator` erases entries, sets and releases legal hold and rotates keys through Operations. They are declared in
`identity.roles` like any other role and given to people by the user directory (or `perActorOverrides`); nothing but
admin access reads them, and the loader refuses a pack that names one in a source's `access`, among the approvers, with
`canApprove`, among the creators of a template or among the roles a purpose permits.

**Show Admin.** The agent's card offers Show Admin to a person who holds either role. It asks the person's phone to
re-authenticate with the set of methods `admin.authentication.methods` names: an `authenticate` flow of purpose
`admin` whose one combination is that set (D127, IDENT-AUTH-015). The set names methods of
`identity.authentication.methods`, and may hold confirming methods only (an authenticator app, a face match): every
method must find or confirm the Principal of the connection. Once the phone confirms, an **admin grant** opens for the
device that asked (the browser or the phone), with the roles the person holds then. The phone is one device across
its sessions: each session it makes through a session grant gets a device handle of its own, so its grant belongs to
its connection, and holds on its next session; no browser, and no other person, ever uses it. It lasts
`admin.grantMinutes` (30 by default) **counted from the confirmation**: use never extends it, and only a new
confirmation opens a new one. It ends at its time, on Hide Admin, when the person loses a role it opened for (a reload
of the directory), when its device is unlinked (for the phone, the handle of any of its sessions) and when the phone's
connection closes. Every read of Audit and every action of Operations carries a reason the person types, names the
verified Principal and the grant, and leaves a record in the admin audit; so do the grant's opening and its end.
Audit finds a person by name (`GET {sessions}/admin/audit/people?q=`: at most twenty Principals the agent knows by
name, a holder of a directory entry or a person an authentication identified, matched on the name and on the address
the agent knows, never answered), to give to its filters that take a Principal. Nothing Audit reads reaches a model.

**The internal admin interface** (D134, RBAC-XSESS-009) exists only when `admin.internal.enabled` is `true` (`false` by
default). Enabled, it listens on `ADMIN_PORT` (3011) on the loopback, never through a Service or an ingress; it serves
what Audit and Operations serve, at the same paths under `/admin` (`/admin/audit/…`, `/admin/operations/…`), to a call
that carries the break-glass token `ADMIN_TOKEN` as a bearer token and a reason (in the query for a read, in the body
for an action); each call is recorded and flagged `breakGlass`. The agent refuses to start with it enabled and no
`ADMIN_TOKEN`. Disabled, no listener opens and `ADMIN_TOKEN` is read by nothing.

```yaml
identity:
  roles:
    auditor:  { description: Reads what Audit serves. }
    operator: { description: Erases entries, sets legal hold and rotates keys. }
admin:
  authentication:
    methods: [badge]          # or a confirming set alone: [otp], [face]
  grantMinutes: 30            # from the phone's confirmation; never extended by use
  internal:
    enabled: false            # true: the break-glass listener on ADMIN_PORT, opened by ADMIN_TOKEN
```

Refused by the loader: a pack that declares `auditor` or `operator` with no `admin.authentication.methods`
(RBAC-ADMIN-002), and a set that names a method `identity.authentication.methods` does not enable.

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
      stewards: [admin]                 # the roles that name an owner of a space with none, or on request
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
- **One owner** controls a space (D135). The owner may name a successor, who becomes the owner when the owner's entry
  leaves the directory; with none, the space has no owner until a holder of one of its template's `stewards` roles
  names one, with a reason (D136). A steward reads nothing else of the space. No `stewards`: nobody can name an owner of
  a space whose owner left without a successor.
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
  badges no `credential` method of the authentication accepts (`409 organization-not-accepted`), and every
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

1. `identity.authentication`: each method of a known type, with the fields of its type only; a `credential` method
   names its schema and a `subjectKey` among the `attributes` it asks; a `face-match` method names its `reference`;
   each combination names enabled methods, each once, holds an identifying method and is listed once; `on-demand`
   lets visitors in; an `email` or `document` method, or a face match with the `directory` reference, needs
   `identity.directory`. No `identity.organizations` pattern sets `relation: home`.
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
12. A space template is declared once; its `creators` and `stewards` are declared in `identity.roles` (rule 2); the default of
    each of its rules lies within its bounds; a template of kind `organization` has the rule `organization: true`
    (SPACE-DEF-003).
13. A badge from the user directory: see `issuance`, "Refused by the loader" (IDENT-DIR-002/003, INTX-AUTH-011/012/015,
    INTX-ISSUE-020). A profile that takes nothing from the directory declares at most one challenge, never `email`.

14. The tool catalog: see `tools: the catalog of tool sources`, "Refused by the loader" (TOOL-CAT-001..010,
    TOOL-AVAIL-002/003).
15. Admin access: a pack that declares `auditor` or `operator` names `admin.authentication.methods`, each an enabled
    method of `identity.authentication.methods` (RBAC-ADMIN-002); neither role is named where a role grants something
    (RBAC-XSESS-008, see `admin`).

Before the schema, a step-up that declares the email code is refused in words (INTX-AUTH-011), and so are a kind of
account of a later phase (`organization`, TOOL-CAT-002) and a source of the catalog with no type or an unknown value
(TOOL-CAT-001). The keys of an earlier pack (`crossSession`, the keys `tools.sources` and an account's fields replaced)
are not read: the schema refuses them as keys it does not know.

## Differences from the previous generation of packs

For readers of the earlier `hologram-ai-agent` packs: `languages` (per-language prompts) is replaced by
one `language.agent` and the frontend's presentation language; `flows.authentication`
(credential definition ids, roles attribute, admin users) is replaced by `identity` (Verifiable Trust
resolution, role rules over verified facts, no admin bypass); `accessMode: user-controlled` and
`userConfig` are gone (deployment-held credentials, and from tools phase 1 a space's account set by its owner in the space's settings); `imageGeneration`, `speechToText` and
`vision` moved under `media`; `integrations` is gone (deployment values are environment variables);
`privacy`, `purposes`, `sessions`, `channels`, `integrity` and `features` are new; MCP servers, HTTP tools and bundled
tools are one map, `tools.sources` (ayni-spec D101).
