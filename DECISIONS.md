# Implementation decisions

Decisions taken while implementing hologram-spec v3, in the order they came up. Spec decisions
(D1 to D47) and requirement ids are cited; nothing here amends the specification.

1. **Runtime.** TypeScript on Node 24, Fastify, provider SDKs behind our own adapter interfaces, no
   agent framework. Project layout from `2060-io/ts-project-template` (Biome, pnpm, vitest, reusable
   CI/CD, Helm chart), with a pnpm workspace for the shared profile package.
2. **Shared profile package.** `@2060.io/hologram-agui-profile` (types, constants, JSON schemas) is
   published from this repo and consumed by `hologram-ui`, so both sides compile against one contract.
3. **Out-of-band invitations.** VS Agent 2.x had no Admin API call to mint a plain connection
   invitation and no event for handshake reuse. Both were added in
   [vs-agent#800](https://github.com/verana-labs/vs-agent/pull/800) (`POST /v2/didcomm/out-of-band`,
   `didcomm.out-of-band.handshake-reused`); the invitation id is the binding nonce (CHAN-BIND-008), a
   new connection carries the record id as `outOfBandId`, a reuse carries the invitation id. Recorded
   as `CC-VSA-002` in the spec's companion changes.
4. **Binding confirmation** is a DIDComm question-answer message (CHAN-BIND-009): question text names
   the agent, the binding code and the client; the yes answer, correlated by connection and thread id,
   binds the session. A device auth challenge uses the same protocol with a per-challenge token.
5. **Identity credentials in the pack.** Schema 3.0 had no place to name the credentials to request on
   connect. An optional `identity.credentials` section was added (`userAgent`, `badge[]`,
   `service[]`), each entry a JSON Schema Credential id or an AnonCreds credential definition the
   DIDComm agent can resolve. Backward compatible (optional).
6. **Development identity fallback.** Devnet has no ECS-Badge issuer. `DEV_ALLOW_UNIDENTIFIED_PRINCIPALS`
   admits a connection without a badge as a Principal with no backing identity (IDENT-ROLE-005
   semantics: `public` only, roles from a rule on `relation: unrecognized`). Refused in production.
7. **Liveness checks** (IDENT-LIVE-002) re-walk the badge issuer's trust chain through the Verifiable
   Trust resolution service (the indexer). Revocation status of the presented credential is checked
   at presentation time (`requireNonRevocation`); a periodic re-presentation on the capability channel
   is not done. A failing issuer chain terminates the Principal's sessions.
8. **Sealed entries.** Text and structured payload of every entry are sealed with AES-256-GCM under a
   per-entry key wrapped by `ENTRY_ENCRYPTION_KEY`; the digest covers the ciphertext (PRIV-ERASE-001).
   Classification columns stay in clear for the scope predicate. Media objects are sealed the same way
   with a per-object key; the agent streams decrypted bytes (PROF-HIST-003, "by streaming").
9. **Scope predicate** compiled once (`memory/scope.ts`) to SQL and to a JS predicate; `crossSession`
   of the widest role widens `session-private` reads to the backing identity or to all sessions
   (RBAC-XSESS-001). The auditor's raw read is not an LLM path and is not implemented as an API yet.
10. **Tool calls never on the wire.** Progress is `StepStarted/StepFinished` with the tool's
    `stepLabel` (first sentence of its description); tool-call entries map to nothing in history
    (PROF-MAP-005).
11. **Approvals on DIDComm** are rendered as a question-answer message (Approve/Reject); a single
    pending approval is decided by the answer. Approved sensitivity actions run in the origin session
    and the result arrives as a server-initiated message.
12. **A2A** is minimal: agent card, `message/send` and `tasks/get`; a peer authenticates with a
    bearer token of a session created for a `verifiable-service` Principal established over DIDComm.
    Task and context ids map to sessions (CHAN-BIND-007). Streaming and push are not implemented.
13. **Anchoring** signs `MsgStoreDigest` with `@verana-labs/verana-types` and cosmjs; the authority
    is `ANCHOR_AUTHORITY` or the policy address of the agent's corporation from trust resolution.
14. **Statistics** go to a Redis stream drained into PostgreSQL by a consumer group, or directly into
    the store, or to an HTTP ingest; the query API is `GET /stats` (PLAT-STATS).
15. **Stub providers** (`stub`) exist for the model, embeddings, speech-to-text, vision and image
    generation so the whole pipeline runs offline; the stub model answers `/call <tool> {json}` with
    a tool call, which the tests use.
16. **Interrupts.** Inline menus are delivered as activities and answered with `menu.select` (or a
    `resume` entry carrying `menuId`/`itemId`); the run is not suspended with an interrupt outcome.
    Mid-run inputs that must block the model are approvals, which end the model's tool call with a
    pending result instead.
17. **One reaction per person per message** (INTX-REACT-004, PROF-RUN-010). The current reaction of
    each Principal lives in the target entry's payload (`reactions[principalId]`), so history carries
    it in `metadata.reactions`; an `add` replaces the previous one, a `remove` clears it. The
    reaction entry is still appended as the audit record. The Principal's own reaction is mirrored
    to the session's channel with `origin: 'principal'`; the DIDComm adapter never echoes it to the
    phone (the app already shows what its user did).
18. **Replies** (PROF-RUN-009). A `text` or `attachments` action may carry `replyTo`, the id of a
    message of the same conversation (or its resume lineage). The turn entry stores a short quote
    in `payload.replyTo`, history exposes it in `metadata.replyTo`, and the model receives the
    quote as a bracketed prefix of the user message. An unknown id is ignored, not refused.

## Not done in this iteration

- Database row-level security, consent management, PII redaction, external IAM (v4 per spec).
- A2A streaming and push notifications; A2A task history beyond the queued replies.
- Periodic re-presentation of credentials for revocation (see 7).
- Reaction policies on DIDComm beyond recording the reaction entry.
