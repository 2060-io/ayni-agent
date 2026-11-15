# Implementation decisions

Decisions taken while implementing ayni-spec v3, in the order they came up. Spec decisions
(D1 to D47) and requirement ids are cited; nothing here amends the specification.

1. **Runtime.** TypeScript on Node 24, Fastify, provider SDKs behind our own adapter interfaces, no
   agent framework. Project layout from `2060-io/ts-project-template` (Biome, pnpm, vitest, reusable
   CI/CD, Helm chart), with a pnpm workspace for the shared profile package.
2. **Shared profile package.** `@ayni.org/ayni-agui-profile` (types, constants, JSON schemas) is
   published from this repo and consumed by `ayni-ui`, so both sides compile against one contract.
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
    phone (the app already shows what its user did). The target may be any message of the
    conversation the session continues (this session or one of its lineage, IDENT-SESS-009), as for the
    quote of a reply: a reaction on a message older than the last idle timeout used to be dropped silently
    (fixed 2026-11-11).
18. **Replies** (PROF-RUN-009). A `text` or `attachments` action may carry `replyTo`, the id of a
    message of the same conversation (or its resume lineage). The turn entry stores a short quote
    in `payload.replyTo`, history exposes it in `metadata.replyTo`, and the model receives the
    quote as a bracketed prefix of the user message. An unknown id is ignored, not refused.

19. **Device pairing outlives sessions** (D51, IDENT-DEV). At every binding confirmed on the phone the
    agent mints a device secret beside the device handle, hands both to the client (bound event and
    status) and keeps only an HMAC of the secret on the Principal's device entry. A session request
    with `deviceHandle` + `deviceProof` binds at once when the hash matches, the pairing is within
    its window (`sessions.devicePairing`, 30 days sliding / 90 hard), the capability channel is live
    and the credential passes its liveness check; the secret rotates on every use and the superseded
    plaintext is dropped from older sessions. A mismatch revokes the device (a copied secret is loud),
    an expired pairing falls back to the known-device question. Pairings are revoked on phone
    disconnection and credential failure, kept on supersede, listed and unlinked from the DIDComm menu
    ("Linked devices", `unlink <n>`) and from `GET/DELETE {sessions}/devices`, the latter also with
    the device's own proof so a browser with no bound session can unlink itself. The idle timeout is
    unchanged: a paired browser simply opens its next session without the phone.

20. **Conversations belong to the Principal** (D52, IDENT-SESS-010..013, PROF-CONV). A `conversations`
    table (`conv_` ids: principal, title, state active/archived/final, preview, timestamps, the
    sessions that served it, newest first). Every AG-UI session attaches to one at binding: the one it
    names (`conversationId`), the one of `resumeSessionId`, or a new one; the conversation's earlier
    sessions become the session's lineage, so the memory scope follows the conversation and a second
    device reads the same history. The first Principal message titles it; every turn refreshes the
    preview and unarchives it. Archive closes its open sessions with reason `user`; final closes them,
    hides the conversation from the list and refuses `POST {sessions}` naming it with `409 final`.
    Ownership is checked at bind (a conversation of someone else is ignored and a new one starts) and
    on every list, rename, archive and delete (404 for another Principal). The phone's DIDComm session
    carries no conversation. Entries are untouched by any of this: retention and erasure govern them.
21. **One open session per device per conversation** (IDENT-SESS-014). When a session binds to or is
    created on a conversation where another bound session of the same device handle exists, the earlier
    one closes with reason `supersede`. Siblings inherit the device handle, so a browser that opens the
    same conversation twice keeps one session; other devices on the conversation are untouched. Found
    live: a browser accumulated five bound sessions on one conversation, each holding a stream.
22. **Renamed from Hologram to Ayni** (2026-10-14). Product, repos, packages and wire identifiers carry
    the new name: `@ayni.org/ayni-agui-profile`, descriptor at `/.well-known/ayni-agent.json`, DID
    Document service type `AyniAgUI` (an existing `HologramAgUI` entry is retyped at boot),
    `forwardedProps.ayni`, `state.ayni`, custom events and activity messages `ayni.*`, Helm chart
    `ayni-agent`. The person's phone app keeps its own name: copy says "wallet app", and the wallet
    link template still points at the app's domain until the app is renamed. No compatibility shim
    for the old identifiers: nothing was deployed under them.
23. **Unidentified peers are a pack choice** (D53, IDENT-RES-007). `identity.unidentifiedPeers`
    (`refuse` by default, `admit`), overridable per deployment with `UNIDENTIFIED_PEERS`, admits a
    wallet that presents no valid identity credential as a Principal with no backing identity, the
    `unrecognized` relation and `public` visibility. The welcome pack admits them: it exists for
    people without a credential. `DEV_ALLOW_UNIDENTIFIED_PRINCIPALS` keeps its development-only
    meaning and is still refused in production. The agent says at boot when it admits them.
24. **The binding question waits for the disclosure on a reuse, and is asked again when it arrives late**
    (2026-11-02; FLOW-CAP-002, FLOW-LINK-001, CHAN-BIND-009; issue #27). A wallet that already holds a
    connection answers a binding invitation with a handshake reuse; the DIDComm agent queries its features
    again, but the binding question was sent at once, so a connection without a recorded disclosure got the
    question-answer form, which a flow-only wallet rejects (with a problem report this agent never sees: the
    DIDComm agent drops generic problem reports). On a reuse the agent now waits for the disclosure as it
    does after a new connection (`DISCLOSURE_WAIT_MS`). When a disclosure naming `ayni-flow/1.0` arrives
    after binding or re-link questions went out in question-answer form, each still-open one is asked again
    as a `link-session` flow that takes over the session's confirmation thread; an answer on the old
    question thread is then ignored. Both depend on the DIDComm agent forwarding disclosures as connection
    events in state `updated`.

25. **The Welcome agent transcribes voice notes with OpenAI** (2026-11-03; MEDIA-STT-001/002, pack rule 7).
    The Welcome pack had `media.speechToText` disabled on the stub model, so its descriptor advertised
    `voiceNotes: false` and the app hid the microphone. It now names OpenAI (`whisper-1`, overridable with
    `STT_MODEL`) with the key in `STT_API_KEY` from the deployment; the agent only advertises voice notes when
    the transcriber is configured, and the note's language hint is the session's presentation locale. A
    self-hosted `openai-compatible` endpoint is one `baseUrl` away when audio must stay in the cluster.

26. **An upload's type is canonical before it is checked** (2026-11-03; PROF-HIST-005). React Native on iOS
    replaces a multipart part's content type with the file's own MIME type, so a voice note recorded as AAC in
    MP4 reaches the agent as `audio/x-m4a` whatever the app declared, and a literal comparison with the
    descriptor's `audio/mp4` refused it. The agent now maps the m4a and aac aliases to `audio/mp4` (and
    `image/jpg` to `image/jpeg`) before the check and keeps the canonical type on the stored object; the
    descriptor keeps listing one type per container.

27. **The greeting belongs to the conversation, not to the session** (2026-11-11; INTX-MENU-001, PROF-CONV-006).
    The greeting and the menu that follows it go to the session that starts a conversation. A session that
    continues one (it has a lineage: a reconnection after the idle timeout, another device linked to the
    conversation) gets none. The rule lives in `Agent.welcome`, so every way of binding follows it; it used to
    be checked only where a session is created already bound, and a browser session linked by the phone was
    greeted again at every reconnection.

28. **One conversation, every device** (2026-11-11; D61, IDENT-SESS-016, PROF-STREAM-005/006, PROF-HIST-007).
    Found live: with a conversation open in the browser and in the app, a message typed on one and its reply
    did not show on the other. A run's events went to the run's own response and nowhere else, and a session
    read its history through the sessions that existed when it was created, so a device opened first never
    read what a device opened later carried.
    - **The mirror of a run** (`channels/agui/mirror.ts`). What a run adds is sent, as it happens, to the other
      bound sessions of the conversation on their streams, inside a server-initiated run: the person's message
      as history will give it (under the agent's id, on the person's side, attachments as activities), then
      the run's own events with their message ids. Text deltas are grouped over 120 ms: one stream write per
      token on every device would be a database write each. A run that adds nothing mirrors nothing. A session
      bound while a run is in flight gets that run from history.
    - **Conversation events** (`CapabilityRouter.deliver`). A message, a menu, a late file, a flow card, a
      reaction or a generating notice served to one session is shown on the conversation's other sessions
      too, quietly: the wake-up goes once, with the session that was served. Approvals keep their own
      delivery (each eligible session gets its own shape), as do a session's state and receipts.
    - **History.** When a session attaches to a conversation, the sessions already open on it take it into
      their lineage, as it takes them: history, the model's window, the quote of a reply and the target of a
      reaction then cover the conversation whichever device carried a message.
    - **State.** After a run the conversation's other sessions get their state again (what is being
      generated, what waits).

29. **A change to a conversation is announced to every device** (2026-11-11; PROF-CONV-007, PROF-CONV-002).
    Found live: a conversation renamed in the app kept its old title in the browser. The rename was stored,
    but nothing told the other devices; each showed the new title only after its next read of the list. The
    agent now sends the `Custom` event `ayni.conversation.changed` (`{ conversationId, title, state }`) on
    the stream of every bound AG-UI session of the Principal, whichever conversation that session serves,
    when a conversation is renamed, archived, unarchived or closed for good, and when its first message names
    it or a new message unarchives it. Archiving and closing announce before they close the conversation's
    sessions, so a device that had it open learns why. The profile package lists the event (3.1.2). The
    preview and the time of the last activity are not announced: a client that shows a conversation has them
    from its own stream, and a list is read again when it is opened.
30. **A phone is never asked to link its own app** (2026-11-12, Fabrice: "I receive a notification in the
    handset for pairing a device, but I do not know from where it comes"; PROF-BIND-009, IDENT-DEV-003).
    Found in the devnet log: the phone's app opened two sessions 3 ms apart with the same device secret. The
    first bound and rotated the secret; the second presented the stale one, so the pairing was revoked, as
    it must be, and the agent then asked the phone whether to link "Ayni on Android": the session of the app
    the person was holding. The re-link question is for a session opened somewhere else. It is now asked only
    for a session whose client platform is `web`; a session of a phone app (`ios`, `android`) gets
    `rebind: "unavailable"` and binds again with a session grant. The same holds when an app's pairing
    expires. The double opening itself is fixed in the app.
31. **Opening a conversation is not activity in it** (2026-11-12, Fabrice: "the latest message is not the same
    in all devices"; IDENT-SESS-013, PROF-CONV-001). Found on devnet: three conversations whose last messages
    were hours or a day old all carried a last activity of the minute the phone had opened them. Attaching a
    session to a conversation set its `lastActivityAt`, so a device that merely opened a conversation changed
    its time and sent it to the top of the list on every other device, and the phone showed that time where
    the browser showed the time of the last message. The time now moves with a message only (and is the
    creation time of a conversation with none). A new pairing still continues the most recent conversation
    (PROF-CONV-006), which is now the one last written in. Times already moved by an opening stay as they are
    until the next message.
32. **A bound session or none** (2026-11-12; PROF-SESS-015, PROF-BIND-009). A linked browser whose sessions
    closed while idle showed a list and a conversation that other devices had moved on from, and could not
    refresh them without opening a session. Opening one by itself, at page load, was not safe: a creation
    that names a known device and cannot bind leaves a provisional session and asks the phone to link it,
    which the person would receive without having asked for anything. `POST {sessions}` now takes
    `silent: true`: the agent binds from the device proof, or answers 409 (`pairing-expired`,
    `pairing-invalid`), keeps no session and asks the phone nothing. A stale proof still ends the pairing.
    The profile package carries the field (3.1.3).
33. **Shared read state** (2026-11-12, decided by Fabrice: a marker per conversation for the devices, the
    viewing entries kept for audit; D62, IDENT-SESS-017, INTX-STATE-004, PROF-CONV-008, PROF-DESC-005). Each
    device counted unread by itself, so a conversation read in the browser stayed unread on the phone.
    - **The marker.** A conversation carries `readUpTo`, the newest message the person has seen on any device,
      and `unread`, the agent messages after it, kept beside it so that listing costs nothing. One value,
      overwritten, with no time.
    - **What moves it.** The `viewed` receipt a device already sends (to the newest message it names that
      belongs to the conversation), and the message the person writes. Never backwards. A receipt that names
      a reply before it is stored (a client may report it as its text ends, and the entry is written just
      after) is held and applied when the reply is stored.
    - **What counts.** After a turn, and when the agent adds a message by itself (a greeting, a late artifact,
      the result of an approved action), the count is taken again from the entries: text, voice and media
      entries of the agent after the marker, up to 99.
    - **A conversation older than the marker** starts from the last message the person wrote, so its whole
      history does not turn up as unread at the first count.
    - **Telling the devices.** The list carries `unread` and `readUpTo`; `ayni.conversation.changed` carries
      them and is sent to every bound session of the person when the count changes. A marker that moves
      under the same count is saved and not announced. The descriptor declares `features.readState`.
    - **The audit trail stays.** Every `viewed` receipt is still recorded as a `state-update` entry with the
      message ids and its time, when receipts are enabled; the marker never replaces these entries and the
      model never sees them. Profile package 3.1.4.
34. **A reply quotes a media message by what it is** (2026-11-13, decided by Fabrice: reactions and replies on
    media now; PROF-RUN-009, D46 of the app). A reaction already reached a media message when a client named
    its entry. A reply to one quoted the placeholder that stands for its attachment (`[file photo.jpg]`). The
    reference now says what the message is (`media`: image, voice, video, file; `filename`) and carries as
    `text` only the words the message has of its own: a caption, the transcription of a voice note. A UI
    names the rest ("Photo", the file's name). The model is still told what the quoted media holds; that
    part stays on the agent. Profile package 3.1.5.

## Not done in this iteration

- Database row-level security, consent management, PII redaction, external IAM (v4 per spec).
- A2A streaming and push notifications; A2A task history beyond the queued replies.
- Periodic re-presentation of credentials for revocation (see 7).
- Reaction policies on DIDComm beyond recording the reaction entry.
35. **An upload is named by the field the client sends** (2026-11-14, decided by Fabrice on my proposal: "go";
    PROF-HIST-008). A file sent from the phone was stored, and shown on every device, as
    `Terms%20of%20service.pdf`. React Native percent-encodes the name it writes on the multipart part and a
    browser does not; the agent kept what the part declared. Decoding on receipt was set aside: nothing tells
    an encoded name from one that holds a percent sign. An upload may now carry a text field `filename`
    before the part `file`; when it is there and not empty it is the attachment's name, with any path and
    control character removed, otherwise the part's name stands (`channels/agui/uploadName.ts`). Additive: a
    client that sends no field is served as before. Files already stored keep their name.
36. **One turn at a time; what is sent meanwhile waits, in the store** (2026-11-14, Fabrice: "when I use for
    example, claude, I still can type and send information while it is thinking. Is it possible to do that with
    our ayni agent?"; then, on the first version, which kept the queue in memory: "why don't you put that
    directly to the store", "why do you want a withdraw?", and "ok go" on: the queue in the store, no withdraw,
    what waits answered together, a message sent before closing the app answered while the person is away;
    D63, CORE-MSG-010, PROF-RUN-011/012/013, PROF-DESC-006).
    - **Before.** Nothing held a second message back: one that arrived during a turn (a second device could
      send one, the UIs only closed Send on the device that was waiting) started a second turn beside the
      first, which did not see the first reply.
    - **One turn at a time.** A turn holds the lock of its conversation while it runs (`core/turnLock.ts`, in
      the agent, so every path that reaches the model passes it: a message, a menu choice, a reaction the
      agent is told of, an A2A task, a DIDComm message). The lock is in the memory of the process, as the
      turn in progress is.
    - **What the person sends meanwhile** (a text or attachments on the AG-UI channel) is recorded at once as
      an entry and listed as waiting in the store (`core/waiting.ts`, in the key-value store: which entries
      wait, by conversation, in order). Its run ends at once and says so (`RunStarted{noTurn: 'waiting'}`): the
      message depends on no open response and no open session.
    - **The agent answers what waits.** Each message that comes to wait takes a place in line for the lock;
      whoever gets it first takes everything that waits into one turn, which the model reads as one user
      message, in order, and answers by one reply. No request carries that turn: the AG-UI channel sends it
      to the stream of every session of the conversation, each device getting the messages it did not send
      and then the reply. Any device of the conversation may stop it.
    - **A restart.** An entry leaves the list when the turn that answered it has ended, so what a restart
      left is still listed; the agent answers it when it starts (`resumeWaiting`). The reply being written
      when the agent stops is lost, as before.
    - **Order.** History is read by the time an entry was initiated. A waiting message is recorded when it
      arrives, during the reply in progress; that reply is recorded when it ends, and is given a time just
      before the first message that arrived to wait, so each reply stands after what it answers. What waits
      is kept out of the context of the turn in progress.
    - **No withdraw** (his decision): a message sent is sent. Stop ends the turn in progress, and what waits
      is answered next.
    - **Limits.** Ten messages wait at most in a conversation; the next is refused and nothing of it is
      recorded (`too-many-waiting`). One replica serves a conversation: the lock is the process's. An action
      other than a message (a menu choice) that arrives during a turn waits for its turn in memory.
    - `features.queue` in the descriptor, `state.ayni.waiting`, profile package 3.1.6.
37. **One agent process at a time** (2026-11-14, found on devnet in the first live run of entry 36;
    PLAT-DEPLOY-004). The agent pod was restarted while a message waited. The chart's deployment replaced it
    by a rolling update: the new pod started while the old one, ending gracefully, was still writing its
    reply. The new one found the waiting message in the store and answered it at start; the old one answered
    it too when its reply ended: two replies to one message. The lock that keeps one turn per conversation is
    the process's (entry 36), so two processes are two locks. The deployment now uses `Recreate`: the old pod
    is gone before the new one starts. A turn in progress is given the grace period to end, as before; what
    waits is answered by whichever process is the only one there. More than one replica stays unsupported.
38. **The agent itself keeps to one process: a lock in the database, and an end that starts nothing**
    (2026-11-14, decided by Fabrice on my proposal, after his question "what happens if a stale lock is in
    the DB?": "It's a Postgres advisory lock => understood. Go."; PLAT-DEPLOY-004/005). `Recreate` (entry 37)
    covers an update only: a pod deleted or evicted is replaced at once, while the old one lives on for its
    grace period. Seen on devnet 0.14.1: the old pod ended its reply and answered the waiting message, the
    new one answered it again at start.
    - **The lock** (`store/processLock.ts`, `Store.exclusive`): before it touches the store, a process takes
      a PostgreSQL advisory lock of the session, on a connection of its own, and keeps it for its life; a
      second process waits there, serving nothing. Nothing is written: the server holds the lock in memory
      and drops it when the connection closes, however the process ended, so none is ever left behind
      (checked against PostgreSQL 16 with `scripts/check-process-lock.ts`: a second process waits, takes
      over within a moment of a `kill -9` of the first, and is told when the database restarts under it).
      The connection asks the server to probe it (10 s idle, 5 s apart, 3 times), so a holder whose machine
      vanished is noticed in about 25 seconds; the holder checks every 10 seconds that its connection
      answers, and a holder that lost it ends at once (`process.exit(1)`): it holds nothing any more. The
      in-memory store has one process by nature. A pooler in transaction mode would break the lock: the
      agent needs a direct connection.
    - **The end of the process** (`AyniAgent.shutdown`, called first by `stop()`): no turn starts any more.
      A message of the person is recorded and listed as waiting, as during a turn, whether its conversation
      is busy or not, and the next process answers it at start; anything else is refused. The turns in
      progress get 20 seconds to end as they would; one that still runs then is cut like a turn the person
      stopped, and the waiting messages it was answering stay listed (a turn the person stops still takes
      them off the list). The streams of the devices are closed, not waited for; the lock is given back
      last; and the process ends within 27 seconds whatever happens, under the 30 an orchestrator gives.
    - **The chart** gains a start-up probe: a pod that waits for the lock is given five minutes before it is
      restarted. `Recreate` stays, it spares the wait on an update.
    - **Mine, for him to confirm:** the 20 seconds given to a reply in progress (a longer reply is cut and
      shows as interrupted); a message sent while the agent restarts waits and is answered by the next
      process instead of being refused.
39. **A voice note is one message** (2026-11-14, Fabrice: "Voice notes show twice after reopening a
    conversation … => fix it"; PROF-MAP-006). History gave a voice note of the person twice: its attachment,
    with the transcription on it, and a text message with the same transcription, as PROF-MAP-006 read ("the
    user message's text"). Live, the sender got the attachment only, so the note showed once until the
    conversation was read again, then twice; the person's other devices got both at once. `entryToMessages`
    now gives the attachment alone when the entry's text is the note's transcription; words the person added
    are still a text of their own, and a note whose audio is gone (retention) still reads as a text. The
    mirror to the other devices is built from the same mapping. Nothing stored changes: the entry keeps the
    transcription as its text, for the model, the search and the previews.
40. **A voice note keeps the length and the waveform its recorder measured** (2026-11-14, Fabrice: "how to
    show the duration? BTW I want to see the waveform of the voicenote in the bubble, too", then "go" on my
    proposal; PROF-HIST-009). A voice note showed "0:00" until played: the attachment had a `duration` that
    nothing filled, and no shape of its sound. The device that records a note knows both. An upload may now
    carry the text fields `duration` (seconds) and `waveform` (a JSON array of 1 to 64 whole levels from 0 to
    100), read by `uploadMeasures` beside the `filename` field; the agent keeps them on the attachment and
    gives them back in `ayni.attachment`, live, to the other devices and in history, and in the answer to
    the upload. A value that does not read is left out and never refuses an upload; the fields count for a
    voice note only. The agent does not open the audio to measure it: that needs a decoder in the image, and
    a note without the fields (an older client, a note already stored) simply has neither. The profile
    package (3.1.7) types `waveform`.
41. **A person is the organization of the issuer, the schema and the badge number; an organization is not a
    DID** (2026-11-14, Fabrice, over several rounds: "the principal cannot be defined with a single
    attribute of a credential, for example for a badge it depends on issuer, too", then patterns over
    Organizations "better than an issuer DID that may change", "Only Orgs" for now, one authentication
    schema, and for `home`: "it's 1. of course"; ayni-spec D59 amended, D64, D65; IDENT-RES-001/002/008..012,
    IDENT-ROLE-008..011). Before: the Principal was found by one attribute of the badge (`id` or `subject`),
    the issuer was read from an attribute the issuer writes itself, the organization was the issuer's DID,
    organizations were recognized by a list of DIDs, and a list of badges asked the wallet for all of them
    while the documentation said one. Now `src/core/organization.ts` computes the **organization key**
    (`org:<countryCode>:<registryId>`, Verifiable Trust v4) in one function from the Organization credential
    that trust resolution returns; `identity.organizations` recognizes an organization by patterns over those
    attributes, first match wins, a pattern giving `partner` or `unrecognized` and optional roles; `home` is
    the organization of the agent's own credential and no other, read through the DID the DIDComm agent
    reports (`HomeOrganization`, looked up again after a failure: an agent that is not onboarded has nobody
    home). `identity.authentication` names the one schema, asked as one requested credential by its
    ecosystem schema. The issuer is `credentials[0].issuerDid` of the presentation record (VS Agent from
    `v2.0.0-dev.110`, vs-agent#837, CC-VSA-011): a record without it, a subject key left unrevealed, an
    issuer that is not trusted or that a Persona backs, identify nobody, and the pack's `unidentifiedPeers`
    then decides. `recognizedBackingIdentities` and `credentials.badge` are gone from the pack schema.
    A Principal keyed the earlier way is found by its earlier key once and re-keyed. Not done here: the
    entries written before keep the DID of the earlier model as backing identity, so shared tiers do not
    match them (no deployment used them); binding after connect (D66) comes with the presentation tools,
    since nothing presents an identity credential after the connection yet.
42. **A reply that ends as the process ends is told to its client to the end** (2026-11-14, found on devnet
    0.15.0 while checking entry 38; PLAT-DEPLOY-005). The check itself passed: the agent pod was deleted
    during a reply with a message waiting behind it; the new pod logged that another process served the
    store and waited, 20 seconds, for the old one to finish its reply and go; the waiting message was then
    answered once, by the new pod, and nothing was answered twice. One flaw showed: the reply the old pod
    finished reached its client complete but without `RunFinished`. The process closed its connections the
    moment the last turn was over, while the run's handler still had its end to write. `stop()` now waits,
    two seconds at most, until no run is being answered (`AgUiRoutes.quiet`) before it closes anything.
    - Seen in the same check, and left as it is: a message sent during the 20 seconds in which neither pod
      is ready does not reach the agent (the terminating pod is out of the service, the new one not yet
      in): its sender gets an error, as before. Only a request that reaches the ending process waits.
43. **Evidence: one record per verification, audit fields in the clear, values sealed and governed per schema**
    (2026-11-14, Fabrice: "this is a governance policy. We should be able to configure the agent to how we
    want. What's important too is to be able to define what the LLM see and what it does not", then "Agree"
    to the defaults, the two ends of a retention and one record with a key of its own; ayni-spec D67, D68;
    PRIV-EVID-001..009, INTX-CRED-001). Before: the table of credential presentations was never written to,
    so `principal_credentials` always answered that nothing was presented, while every attribute of the badge
    was copied on the Principal for good and the name went to the model. Now `EvidenceService`
    (`src/core/evidence.ts`) writes one record when a presentation identifies a peer: audit fields without
    any value, and the values `store.attributes` names sealed with a key of the record (the mechanism of
    entries: digest over the ciphertext, the key destroyed on erase). `store.retention` gives the days and
    `onExpiry` (`erase` by default, or `archive`); the retention job applies it; a credential presented again
    erases the values of the earlier record. A Principal keeps of its credential the stored attributes and
    the issuer, and loses them when their retention ends; the subject key lives in the actor identity.
    `modelVisible` decides what `principal_credentials` shows and whether the model, and the greeting it
    reads, name the person. By default nothing is stored and nothing is visible: a pack must say so to keep
    the name. Memory schema 3.3.0 adds the `evidence` table and drops the unused one. Not done here: the
    document read, whose event carries the raw data groups and no parsed field, so its values need the
    DIDComm agent to send them with the outcome of its verification; an interface for the auditor
    (`EvidenceService.audit` is ready for it); evidence of catalog entries, which come with the request tool.
44. **The authentication is asked on connect or on demand, and who enters unidentified follows from it**
    (2026-11-14, Fabrice: "this should be configurable in agent pack: on connection, on demand", then on the
    separate setting: "it could be implicit from authentication configuration", "and that eliminate 5",
    "Agree to all. Go."; ayni-spec D53, D65, D66 amended; IDENT-RES-007/010/013..017). `identity.authentication`
    gains `request`: `on-connect` (default) identifies a person or refuses them; `on-demand` asks nothing at
    connection. `identity.unidentifiedPeers` and `UNIDENTIFIED_PEERS` are gone: a pack with no authentication
    schema, or one asked on demand, admits everyone unidentified (`admitsUnidentified`), and the mode "asked
    on connect, admitted when declined" no longer exists. On demand the credential is asked by the model,
    through the bundled tool `request_presentation` (one parameter, the entry; absent from the model's list
    for an identified person, by a new `when` on a tool), or by the person, through the platform menu item
    "Identify yourself" (`IdentityRequests`). One request is pending on a connection at most, and the model
    waits ten minutes after one that was declined or left unanswered. What comes back binds by
    `AyniAgent.onIdentityPresented`: an unidentified connection is upgraded, its sessions, conversations and
    entries moving to the identified Principal with the devices paired on it (working memory and preferences
    are not merged); an identified one accepts the same Principal only, another identity being refused with
    nothing kept. Known limit: the entries a turn in progress writes after the upgrade still carry the
    visitor's Principal; they are session-private, so the conversation reads them all the same.
45. **The presentation catalog: the agent asks only for what the pack lists** (2026-11-14, Fabrice: the model
    may "request one later and maybe choose in a list of presentable credentials, based on the context";
    ayni-spec D69; INTX-PRES-001..008). `presentations` in the pack names each credential the agent may ask
    for, with its subject kind, when it is asked (`on-connect`, by the code after the connection, or
    `on-demand`), a purpose, and the three lists of evidence. `request_presentation` takes the name of an
    entry: its list holds `authentication` for an unidentified person and the on-demand entries, and the
    tool refuses an entry that is not of the peer's kind. `IdentityFlow.present` asks one credential by its
    schema with the purpose as the title of the flow, reads the issuer from the presentation record and its
    organization from trust resolution; `IdentityRequests.present` records the result as evidence of the
    Principal of the connection, which binds nobody. The no-insisting rule of the authentication applies per
    entry. Known limits: a wallet without flows is not shown the purpose (the present-proof request of the
    DIDComm agent carries no comment); asking a service for a credential follows the same path and was not
    tried against a real service.
46. **Issuance: every claim has a source, and the model is never one** (2026-11-11 to 14, Fabrice: "I do not
    want the agent to be corrupted by user and issue arbitrary credentials", then "a tool must list the
    missing attributes and what are the actions to get them", "two tools", "the three triggers", forms left
    out; ayni-spec D68, D70; INTX-ISSUE-001..014, RBAC-FILTER-003). `issuance` in the pack names each
    credential the agent may issue, with one source per claim. `IssuanceService` (`src/core/issuance.ts`)
    answers `credential_requirements` (state held, ready or incomplete; per claim a status and an action,
    never a value) and runs `issue_credential`, whose only parameter is the name of the profile: the claims
    are resolved in code from the stored values of evidence and from computed values, for the Principal of
    the session, and nothing is issued when one is missing. `trigger` is `model`, `request` (a platform
    menu item "Get <label>", the profile absent from the model's list) or `automatic` (run when evidence is
    recorded). The challenge of a profile runs inside the issuance, since one tool serves every profile.
    `CredentialOffers` sends the offer through the DIDComm agent, as an `issue` flow on a flow-capable
    wallet, and waits for the exchange. An issuance is recorded as evidence of kind `issuance`. Not in this
    version: the sources `record`, `attestation` and `declared`; a claim read from a document (the document
    read is not recorded yet, entry 43); issuing to a service, which under Verifiable Trust v4 goes through
    the credential flow the peer starts.

47. **The number of a badge is derived, not drawn** (2026-11-15; ayni-spec INTX-ISSUE-015/016). A credential
    that numbers its holders needs a claim no evidence holds. The `computed` source gains `subjectId`, and
    its functions become a closed list (`COMPUTED_FUNCTIONS`), checked by the schema and by the cross-field
    rules. The value is 80 bits of HMAC-SHA-256 over the name of the profile and the id of the Principal,
    in 16 Crockford base32 characters, under a key derived with HKDF from `ENTRY_ENCRYPTION_KEY` and the
    label `ayni-agent/issuance/subject-id` (`subjectIdKey`, `subjectId` in `src/core/issuance.ts`). Derived
    rather than random, so a person keeps the number at a new issuance and nothing is stored for it;
    keyed, so the number tells nothing of the Principal and two profiles cannot be linked. Rotating
    `ENTRY_ENCRYPTION_KEY` changes the numbers. Not solved here: a person who received a badge as an
    unidentified Principal and then authenticates with it is another Principal; a pack that issues its own
    authentication credential offers the profile to the roles of the unidentified only.

48. **A profile names its credential by definition or by schema** (2026-11-15, Fabrice agreed; ayni-spec
    INTX-ISSUE-017). A credential definition exists only once the VS Agent created it, and its identifier
    holds the agent's DID: a pack that names it serves one wallet. `issuance.<name>.credential` takes
    `jsonSchemaCredentialId` as an alternative, exactly one of the two (schema and cross-field rule).
    `CredentialDefinitions` (`src/channels/didcomm/credentialDefinitions.ts`) lists the definitions of the
    VS Agent (`GET /v2/anoncreds/credential-definitions`, every page), takes the one whose
    `relatedJsonSchemaCredentialId` is the schema, else creates it (`POST`, a 409 means one exists by now).
    One look-up at a time per schema, so two callers never create two; the result is kept for the life of
    the process, a failure is not. `IssuanceService.prepare()` runs at start without blocking it; `issue`
    resolves again when needed and answers `not-ready`, a new outcome, when no definition can be had. The
    creation needs no entry on the registry; the offer does, and the VS Agent checks it then.
