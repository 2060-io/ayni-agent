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
16. **Interrupts.** Inline menus are delivered as activities and answered with `menu.select`; the run is not
    suspended with an interrupt outcome, and no `resume` is read (decision 76).
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
    status, once: decision 75) and keeps only an HMAC of the secret on the Principal's device entry. A session request
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

50. **The agent tells a peer where it stands** (2026-11-15, decided with Fabrice; ayni-spec D71, IDENT-STAT-001..008,
    CHAN-BIND-014, PROF-DESC-007). A wallet that asked for its session grant while the agent was still
    identifying it was refused, and nothing told it when to ask. The agent now sends `peer-status/1.0/status`
    on the connection: the authentication rule, whether the peer is identified, and what is open to it.
    `PeerStatusNotifier` (`src/channels/didcomm/peerStatus.ts`) derives the three fields from the agent-pack
    and the Principal and from nothing else, so the status and the session grant cannot disagree: the grant
    handler refuses an endpoint that `openFor` does not list. It is on `AyniAgent.peerStatus`, optional as the
    other DIDComm services are. Sent from four places: `DidcommEvents.onConnection` (before the identification
    under `required`, after `onPeerConnected`, with a refusal before `deleteConnection`), the
    `onIdentityPresented` dependency of `IdentityRequests` in `app.ts`, `AyniAgent.onCredentialInvalid`, and
    a late features disclosure. The refusal code comes from `IdentityFlow.establish` through `onRefused`,
    because only it knows whether the trust resolution, the user-agent gate or the credential failed. The same
    status is not sent twice on a connection (kept in memory: after a restart a peer may get it once more).
    A `query` is answered by the VS Agent from the last status sent; the agent answers only when the VS Agent
    held none. **The descriptor declares `features.peerStatus` only when the VS Agent has the route**
    (`VsAgentClient.supportsPeerStatus`: a query with no connection, 400 with the module and 404 without, and
    nothing is sent). A wallet waits for the status of an agent that declares the feature, so an agent on a
    VS Agent without the module must not declare it; it is asked again every minute while the answer is no.
    Deferred: what a service may open (`a2a`, ayni-spec O20), so a service gets `open: []` and no session
    grant; the client side of the protocol, where this agent would act on the status another service sends.
    There is no entry 49. It was a wait in the session grant handler, for a request that arrived while the
    peer was being identified (pull request #73, ayni-spec CHAN-BIND-016). It was closed without being merged
    and the requirement withdrawn: with the status a wallet no longer asks early, the wait did not cover an
    identification that takes minutes, and two answers to one problem would hide a fault in this one.

51. **What the agent says after a wait is a new message** (2026-11-15, found by Fabrice on devnet with a phone:
    "when I present the badge to the agent, it looks like the agent is not notified"; ayni-spec CORE-MSG-011,
    INTX-ISSUE-018). The agent was notified: its tool returned `issued`, then `identified`. But the model had
    written "I sent the offer to your wallet, please check" before the call, the person went to their wallet,
    and what the model said afterwards was appended to that same message, with no space ("Here it
    goes.The offer was declined"). Nothing new showed in the conversation.
    - `Orchestrator.answer` keeps the time its tools began once the agent has said something. When the reply
      resumes `resumeAsNewMessageMs` later or more (five seconds), the message before it ends, is saved, and a
      new one starts under a new id: the stream carries a `text-end` and a `text-start`, and history holds two
      messages. Under that the same message goes on after a blank line.
    - Five seconds is a pause a person notices, and no tool that only reads takes it; a wait on the wallet
      always does. A rule on time needs no list of the tools that wait.
    - The first message sits where the reply does (after the messages it answers, D63); one written after a
      pause sits where it was written. `TurnResult.reply` is the last message and `replies` all of them; a
      peer service on A2A reads them as one text.
    - **How an offer ended is told apart.** `CredentialOffers.offer` answered `declined` when the person said
      no, when nobody answered and when the wallet refused the offer by itself. It now answers `declined`,
      `unanswered` or `refused` with the wallet's code, from how the flow closed, and the model and the person
      are told which. The first test on devnet failed on a wallet that refused every offer as from an
      untrusted issuer; the agent said "declined or left unanswered" and offered to try again.
    - The descriptions of `issue_credential` and `request_presentation` say that the call sends and waits, so
      that a model does not announce as sent what it has not sent yet. This is help, not a guarantee: the
      split above is what holds whatever the model writes.
    - Not done: a flow asked from a conversation does not show as a card there (`origin` is not passed for an
      offer nor for a presentation asked on demand).

52. **A protocol a peer uses is one it speaks** (2026-11-15, same test; ayni-spec CHAN-PROF-007). After the
    phone removed its connection and connected again, its features disclosure did not leave the phone (one
    websocket that did not open, and Credo does not send again). The agent waited three seconds, took the
    phone for an older wallet, sent it a welcome and a menu it does not read, and later an offer outside a
    flow, which the phone refuses. Nothing would have repaired that connection.
    - `DidcommEvents.learnt` records a protocol the peer was seen to use in its profile, as its disclosure
      would have: `ayni-flow/1.0` when the peer opens a flow (a session grant request always comes in one),
      `peer-status/1.0` as a receiver when it sends a query. From then on the peer is served in flow mode,
      questions still open are asked again as flows, and it is told of its status when it changes.
    - It does not help an agent that asks for a credential on connect: that request leaves before the peer
      has opened anything. The app now sends its disclosure by itself and again when it does not go
      (ayni-app), which is the repair of the cause; this is the repair of the consequence, for any wallet.
53. **A person authenticates in a step of its own, in one of three modes** (2026-11-16, decided by Fabrice;
    ayni-spec D72, IDENT-RES-007/010/015 amended, IDENT-RES-018..021, IDENT-STAT-002/003/006, flow profile §4.1
    and §6.14). Before, a required credential had one attempt and a failure deleted the connection; an agent
    that let guests in asked nothing at connection; a guest asked to be identified only from a menu item
    inside a conversation; and the credential of any accredited issuer was accepted.
    - **The modes** follow from the authentication entry of the pack (`authenticationModeOf`): `request:
      on-connect` is **required**; with `guests: true` it is **offered**; `request: on-demand` is **on
      request**, which lets guests in by itself. The entry may list the organizations accepted
      (`issuers.organizations`) and say how the credential is obtained (`obtain`); the status carries both.
    - **One request is one attempt** (`IdentityFlow.authenticate`): an `authenticate` flow, valid five
      minutes, that ends accepted, not accepted with a reason, declined or unanswered. The agent decides on a
      presentation that verified before the flow closes: accepted, the flow completes; not accepted, it
      fails with the reason's code (`issuer-not-accepted`, `not-valid`, `incomplete`) and the caller asks
      again. An identified connection asked again (to reveal its email) refuses another identity on the flow with
      `another-identity` and asks nothing again (decision 75).
    - **At connection** (`establishPerson`): a decline refuses the peer when the credential is required
      (`authentication-declined`) and admits a guest when it is offered; no answer in time refuses in both
      (`authentication-unanswered`). No Principal exists before the outcome: a credential accepted then
      binds the connection directly.
    - **A guest asks from their wallet** with `peer-status/1.0/authenticate`, relayed by the DIDComm agent
      as `didcomm.peer-status.authenticate-received` and served as the person's own request. The agent's
      menu item is renamed Authenticate and is no longer sent to the Ayni app, which has its own entry.
    - **Nothing is kept for an earlier wallet** (Fabrice: there is none). A wallet without flows, which
      cannot be told why a credential is not accepted, is asked once. The refusal `identity-refused` is
      gone with the single attempt.
    - Needs the DIDComm agent built with the protocol packages that carry the new status fields, the
      `authenticate` message and the refusal codes (credo-ts-ayni-flow #29): the earlier plugin refuses
      the new codes, and this agent no longer sends the old one.
    - By tests: the three modes at connection, the organizations accepted, a credential asked again, the
      status fields, the guest's request, the menu item, the rules of the pack. Not run against a DIDComm
      agent, which is not built yet.
54. **A wallet's decline is a decline, not a presentation that failed** (2026-11-16, found by Fabrice on
    devnet with a phone, an hour after 0.20.0: "continue as guest => show again the authentication window";
    ayni-spec IDENT-RES-019 amended).
    - **Cause:** a wallet that declines sends the problem report of present-proof, then closes the flow. The
      DIDComm agent reports the first as a presentation record `abandoned`, with the wallet's words
      ("abandoned: Request declined"), and it reaches the agent a moment before the close. Entry 53 took
      every unverified record that was neither `declined` nor a timeout for a presentation that came and
      did not verify: the agent answered `not-valid` and asked again, each time the person declined. With
      the credential required it would have looped the same way in place of ending the connection.
    - **Fix:** `declinedByHolder(record)`: the state `declined`, or the wallet's words of a decline. Such a
      record is the person's refusal: no reason is sent, and the request ends declined.
    - My tests of entry 53 declined through the close of the flow alone, which is the second of the two
      messages a wallet sends. The new test sends both, in their order; it fails without the fix. A record
      `abandoned` for another reason ("Invalid proof") is still answered `not-valid` and asked again.
55. **A badge may be issued from a passport or an identity card** (2026-11-16, decided by Fabrice; ayni-spec
    D73, INTX-AUTH-010, PRIV-EVID-011/012, INTX-ISSUE-019). Until now the `document` challenge sent a bare
    request and kept "document read: yes".
    - **The read** is the `document` challenge of an issuance profile, run as an `nfc-read` flow: one
      request for the data of the chip under the flow id, valid five minutes, asked only of a phone that
      disclosed `mrtd/1.0` (`DidcommAdapter.requestDocument`). No request for the machine-readable zone:
      the phone reads it itself to open the chip, and it comes back in the chip's data, signed.
    - **What is kept** (`src/core/document.ts`). The agent reads the raw data groups the DIDComm agent
      reports, DG1 and DG2, and only when that agent says both that the signer chains to a state it
      trusts and that the data matches the signature, and the document has not expired. Otherwise the
      read is recorded with its reason and no value, the flow is closed `not-valid`, and the challenge
      fails with the reason, which the model is told in words. The attributes are a closed list
      (`DOCUMENT_ATTRIBUTES`), declared under `evidence.document` in the pack.
    - **The portrait.** A chip usually holds it as JPEG 2000, which the Badge schema refuses. It is decoded
      with OpenJPEG as WebAssembly (`@cornerstonejs/codec-openjpeg`), reduced to 240 pixels on its longer
      side, and encoded as JPEG (`jpeg-js`) under 24 kB: a credential that carries a full picture is heavy
      to deliver. The specimen's 413 by 531 portrait weighs 42 kB as a JPEG before the reduction.
    - **The number** (`documentId`): a keyed digest of the profile, the issuing state and the number of
      the document, written as `subjectId` is. One document gives one number through any connection: a
      guest is a new Principal each time, and `subjectId` would number them again. A renewed document
      gives another number, and so another identity; Fabrice: "for this first version it will be ok".
    - **The issuance** no longer needs every claim before it starts: what its own document challenge
      reads is `missing` with the action `issue_credential`, and the credential is `ready`. A read that
      is still good is not asked again, so a person who declined the offer is not sent back to the chip.
    - **Not done by the agent, because it cannot know:** the specification says the agent warns at start
      when the DIDComm agent has no list of state certificates. The agent does not see that
      configuration: it says so in its log when a read arrives with no verification result. The
      specification is to be corrected.
    - **What this proves:** that the document was in hand. No chip authentication, no face match.
    - By tests, on the public specimen of the BSI reference data set (TR-03105-5, Erika Mustermann), with
      no data of a real person: the zone and its check digits, the portrait conversion, each reason a
      read is not kept, the flow and its close, the issuance and the number, the rules of the pack. Not
      run against a phone: the app cannot read a chip yet.
56. **What the system did is told to the model as a record, never in the agent's voice** (2026-11-16, found
    by Fabrice on devnet with a phone, at the first document read: "when I ask the model to retry, I see a
    message [note] Read your passport or identity card, but I have no command link to trigger the reading").
    - **Cause:** a request shown on the phone, an approval and a challenge are kept in the conversation, and
      the history the model reads held each of them as a line of the agent, `[note] <text>`. A request reads
      as its title. After a read that expired the history held, in the agent's voice, "[note] Read your
      passport or identity card" right after the person's "Retry". At the next "Retry" the model wrote that
      line as its whole answer and called no tool: nothing was sent to the phone, three times in a row.
    - **Fix:** `systemRecord`: these entries are given in the other side's turn, framed as records the
      system wrote, and a request says what became of it ("it is expired and over: nothing is on their
      phone now"). The platform rules tell the model never to write such a line and to call the tool again
      when a person asks again.
    - With it, the word of a document read that did not pass says that nothing is on the phone any more
      and that the model must not announce a request: in the same test the model had answered "Your phone
      will now ask you" to a tool that had just said the phone could not.
    - By test: the record of a request in each state, and that no record starts as a line of the agent.
      That the model no longer copies it is to be seen on devnet: it is a behaviour of the model.
57. **A deployment sets the token budget of the context window** (2026-11-17, Fabrice: "we should increase it
    to max 100k for now, so that we can see the effect of caching and other improvements").
    - The Welcome pack reads `memory.contextWindowTokens` from `CONTEXT_WINDOW_TOKENS`, `8000` when it is
      unset (ayni-spec reference profile). Devnet sets `100000`; testnet keeps `8000`.
    - What fills the window is still bounded by the 200 newest entries the window reads, and the budget
      is still an estimate (characters / 4 of the text of each entry): the measure of what the model
      receives comes with the usage accounting of the context work.
58. **The context, measured and assembled for caching; scope by conversation; erasure reachable** (2026-11-18,
    ayni-spec D74 to D78; Fabrice: "I want to see context size / context max size in all conversations, just below
    the message form, in small chars", "if summarization is better, then directly summarization", "for now focus
    only on Kimi model").
    - **Usage:** every model call reports what the provider counted; the Kimi adapter reads `prompt_tokens`,
      `prompt_tokens_details.cached_tokens` and `cache_write_tokens` (parts of `prompt_tokens`, as Moonshot's
      documentation says). A turn keeps its sums with its reply (`payload.usage`), logs one `model call` line per
      call and records `llm-input`, `llm-cached`, `llm-cache-write` and `llm-output`; the conversation's figure is
      in `state.ayni.context`, the same on every device.
    - **Caching:** `llm.cache` sends the conversation as `prompt_cache_key` and `prompt_cache_options.ttl` (5m). The
      request goes from what changes least to what changes most, tools sorted, what recall finds after the window,
      inside the person's turn as a record. Live on Kimi K3: from the second turn most of the input is served from
      the cache (71% at turn 2, 96% at turn 8 of a test conversation).
    - **Summarization in steps, not trimming first:** the window keeps its first entry until the budget is reached,
      then drops its oldest entries down to 60% of it in one step; what it drops is folded with the previous summary
      by the same model. The summary is sealed in the key-value table, never an entry, discarded when an entry it
      covers is erased and made again at the next turn; a failed summary leaves the turn within the budget. Live on
      Kimi K3 with a small budget, a question about facts that had left the window was answered from the summary.
    - **The estimate** counts what the model receives (tool results, file text, tool definitions, what recall adds,
      a fixed cost per image) and is scaled by the ratio between Kimi's last reported input and its estimate.
    - **Scope by conversation (D76):** `conversation-private` replaces `session-private`; an entry carries its
      conversation (`conversation_id`), so a conversation reads whole whatever the number of its sessions (the list of
      earlier sessions was capped at 30, and at 10 on the resume path). A session outside AG-UI conversations is its
      own conversation, continued by the sessions that resume it (`rootSessionId`). Each store declares the
      visibilities it holds and the predicate is compiled for it: the document search compiled the entries'
      predicate and failed on PostgreSQL (`column c.session_id does not exist`, reproduced on pgvector 16).
      Working memory and preferences are read through it and logged.
    - **No plaintext beside the ciphertext (D77):** no preview of an entry; an attachment's text (a transcription,
      a description, the text of a file) and its file name are sealed with the entry, its reference and measures
      stay beside it; a conversation's title and last text are sealed, the last text recomputed after an erasure.
      What an earlier version kept in the clear is sealed at start (an erased entry loses it).
    - **Erasure reachable (D78):** `DELETE /sessions/:id/messages/:messageId` and `POST
      /sessions/conversations/:id/erasure` for the person's own messages, `ayni.messages.erased` to every device;
      the cascade reaches the tool calls of the turn, the notes that cite the message, the arguments of its
      approvals, the summary and the last text. The admin interface (`ADMIN_PORT`, 3011, loopback only, optional
      `ADMIN_TOKEN`) erases, sets and releases legal hold and serves the auditor's reads, each call recorded with
      its operator and reason.
    - **Tests:** the in-memory suites, plus `pnpm test:postgres` against pgvector in Docker (also a CI job): the
      migration from 3.3.0, the document search of each organization, no plaintext of a message or a conversation,
      the conversation read in order.
    - **Not done here (Kimi first):** the Anthropic adapter still reports no input and sends `budget_tokens`; other
      providers follow.

59. **Working-memory notes and preferences, sealed** (2026-11-18, found while reviewing data visibility; ayni-spec
    D77 and PRIV-ERASE-009). Decision 58 sealed what an entry and a conversation kept in the clear, but a note's
    content and a preference's name and value were still plain text in `working_memory` and `preferences`, and a
    note says what the model learnt from a conversation. They are now sealed like the rest.
    - **A note** keeps its content as ciphertext under a key of its own (`sealed` in its record, `content` empty).
      The owner, visibility, state, lineage and dates stay in the clear: the scope predicate and the erasure
      cascade read them.
    - **A preference** keeps its name and value as ciphertext under a new key at every write. The table's `key` holds
      a keyed index of the owner and the name (`EntryCrypto.blindIndex`, HMAC-SHA-256 under a key derived from the
      master key), so a preference is found and replaced by its name without the name being stored. A preference's
      name is free text the model chooses and can say as much as its value. The access log names a preference by
      that index.
    - **Through the memory service only:** the preferences tool now writes through `MemoryService.setPreference`;
      the sealed repositories are in `src/memory/sealedMemory.ts`.
    - **At start,** what an earlier version kept in the clear is sealed (`sealPlainNotesAndPreferences`); a plain
      preference row is stored again under its index and the plain row removed. Schema 3.5.0 adds `enc_key_ref` and
      `cipher` to `preferences`.
    - **Tests:** `tests/sealedMemory.test.ts`, and a PostgreSQL test that finds no canary of a note, a preference
      name, a preference value or a legacy row in the tables or the access log.
60. **Spaces, memories per space, and deleting a message within its window: phase 1** (2026-11-19, Fabrice's decisions
    of the design review of spaces, memories, people and erasure; ayni-spec D80 to D93, PR #94). Phase 1 is everything
    but the people: the user directory, invitations, the email code and the admin view come in phase 2.
    - **Deleting a message (PRIV-ERASE-007, PRIV-ERASE-010 to 012, PROF-HIST-010):** a person deletes a message they
      wrote while it is younger than `conversations.messageDeletionWindowSeconds` (600 by default; 0: nobody, and the
      descriptor declares no `erasure`), `409 window-passed` after it. With it go, crypto-erased, the agent's messages,
      the tool calls and the memory lines of the turn that answered it: every entry of a turn now names the messages it
      answers (`inboundId`, `inboundIds`), the reply and the code's refusal included. The memories whose lineage cites
      the message or an entry of its reply are deleted, not flagged, with no line of their own; a memory the message
      changed is deleted, not reverted (its previous content is kept nowhere). A message that waits for its turn leaves
      the list; one whose reply is being written cancels that turn first (the runs of the conversation are stopped as
      the person would stop them), and what the turn recorded is erased once it has stopped (15 seconds at most, else
      `409 turn-in-progress`). The flow, approval and auth-challenge cards of the turn stay, and preferences are not
      touched. `ayni.messages.erased` names every message erased. A person cannot erase a conversation any more: the
      endpoint answers 404, `eraseOwnConversation` is gone, and an operator erases through the admin interface, which
      keeps the flagging of PRIV-ERASE-005.
    - **No role reads other people's conversations (RBAC-XSESS-001/005/007):** `crossSession` is withdrawn; a pack that
      declares it, whatever its value, is refused at start with a message that says why. `conversation-private` is the
      conversation and nothing else. The pack accepts `roles.<name>.admin` (IDENT-DIR-008), unused before phase 2.
    - **Spaces (SPACE-DEF-001 to 007):** a space (`spc_…`, of the agent) has a kind, a template, a title, a purpose, a
      brief, a language, its rules (`retentionDays`, `lawfulBasis`, `allowedProviders`, `handover`), a membership (a
      list, or a rule of exactly one of `department`, `group`, `organization: true`) and an owner. The store seals the
      title, the purpose and the brief, and an invited person's email (found by a keyed index), as D77 seals a
      conversation's title; the lists and the membership read what stays in the clear. Templates come from
      `spaces.templates` (`id`, `title`, `kind`, `creators`, `membership`, `rules` with a default and `min`/`max` or
      `allowed`); a template of kind `organization` has the rule `organization: true`. Personal, `personal:<principalId>`,
      is never stored: its rules are `spaces.personal` (365 days, or `RETENTION_HISTORY_DAYS`; the conversation memory's
      basis; `llm.providerName`), and it takes no handover. Schema 3.6.0 adds `spaces`, `space_members` and
      `space_activity`, and a `space_id` to conversations, entries and notes, those of an earlier version in Personal.
    - **Members (SPACE-MEMB-001 to 008):** the owner is always a member. A rule matches the department or the groups of
      the Principal's directory entry, never a claim; phase 1 has no directory, so a department or group rule gives the
      owner only, and `organization: true` every Principal whose relation is `home`. A member the rule no longer
      matches, or the owner removes, is `left`: their own conversations of the space stay readable, a run on them
      answers `409 space-left` and records nothing, and they open no new conversation there. Adding a member answers
      501 for an owner (409 `rule-membership` in a rule space); the owner gives the space to an active member, and
      every action is in the space's activity, by field name, never by value.
    - **Conversations in a space (SPACE-CONV-001 to 003, PROF-CONV-010/011, PROF-STREAM-009):** `POST {sessions}` with
      `newConversation` and `spaceId` starts the conversation there for an active member, `404` otherwise (bound later
      by the phone, it goes to Personal); `PATCH {sessions}/conversations/{id}` changes its space, and its entries',
      until the person's first message (`409 has-messages`). The list carries `spaceId` and `shared`, filters by space,
      and every session gets `state.ayni.space`, again when the space or its title changes. A guest who identifies
      takes their Personal conversations, entries and memories to the identified Principal's Personal space.
    - **Memories per space, preferences global (MEM-SPACE-001 to 007):** a note carries the space of the conversation it
      was written in. The scope predicate has a space: a store that declares a space column (entries, notes) reads its
      `principal-private` items in that space only, a store that does not (preferences) in every space. The
      working-memory tool lists, changes and removes the notes of the conversation's space only (`maxNotes` per space);
      a change adds the message to the note's lineage. The platform rules (add-on 3.2.0) tell the model to write notes
      in the person's language and to change one when the person says it is wrong. `GET {sessions}/memories`,
      `DELETE {sessions}/memories/{id}`, `DELETE {sessions}/preferences/{key}` and `GET {sessions}/about-me` serve the
      person alone. Each message of a reply records `usedMemories` and `usedPreferences`, which the person's own
      history returns in `metadata` (empty lists for a message outside a turn; no live field). A memory the model adds,
      changes or removes is a `state-update` entry after the reply (`{ kind: 'memory', memoryId, spaceId, action }`,
      never its content), live as `ayni.memory.updated` and in history as `ayni.memory-update`; the model never reads it.
    - **Handover (SPACE-SHARE-001 to 004, PROF-CONV-012, PROF-SPACE-007):** the author shares a conversation with its own
      space while the space takes handovers (`409 handover-not-allowed`, Personal included; `409 final`); its active
      members list it and read its transcript and attachments as they are now, without the author's memory lines and
      `used…` lists; one who left, and an unshared conversation, get 404. **My choices, H1 and H2 being unanswered:**
      only within the conversation's own space; live until the author stops sharing, whatever their membership.
    - **Allowed providers (SPACE-CONV-004, PROF-RUN-014):** before any model call the turn checks that
      `llm.providerName` (`llm.provider` when absent) is among the space's `allowedProviders`; when it is not, the
      person's message is kept and the code answers with a `refusal` entry, a message of the agent in history: no model
      call, no summary, no memory.
    - **Retention (PRIV-RETN-008/009):** the job archives the entries of each space older than its retention, Personal's
      by `spaces.personal`, never an entry on legal hold; it replaces the one threshold of every history.
    - **Profile package 3.3.0:** the types, endpoints, errors and events above; `features.erasure` is
      `{ windowSeconds }`; the descriptor says `3.3`.
    - **Choices of mine, beyond the spec:** Personal is computed, never written (the spec's "created when first
      needed" is the same on the wire); the list of templates carries their bounds (`rules`) for the owner's form, and
      the share answers its conversation and space beside `{ shared, sharedAt }`; the deletion waits 15 seconds for a
      cancelled turn.
    - **Not done here (phase 2):** the user directory (D79, IDENT-ROLE-012 to 014, IDENT-DIR), the department and
      group facts it gives the rules (`SpaceService.directory` is the hook), adding members and invitations
      (SPACE-MEMB-002, SPACE-INV), `GET {sessions}/directory` and `/organizations`, the email code and SMTP, the admin
      view, `joined` and `left` on a reload, and the issuing state as the `source` of a document in `about-me`.
    - **Tests:** `tests/spaces.test.ts` (the space endpoints, membership, leaving, a conversation's space, memories,
      handover, providers, retention), the deletion and its cancellation in `tests/turns.test.ts`, the pack rules in
      `tests/pack.test.ts`, the space of the predicate in `tests/policy.test.ts`, and on PostgreSQL the migration to
      3.6.0, the space stores, no plaintext of a space or an invited email, and the agent served from PostgreSQL with
      no plaintext of a space in any table.
61. **The user directory, roles by hand, and removal that revokes: phase 2a** (2026-11-19, Fabrice's decisions of the
    design review, review decisions 13, 14 (answer a), 17 and 18; ayni-spec D79, D81, D87, D91, D92, PR #94). Phase 2b
    follows: the badge from the directory (the passport match, the email code, SMTP), the invitations of other
    organizations and the search of organizations.
    - **The file (IDENT-ROLE-012, IDENT-DIR-001, CORE-PACK-001):** `identity.directory.file` names it, a relative path
      from the pack directory. It holds `people`, each with `id`, `firstName`, `lastName`, `email`, optional
      `birthDate` (`YYYYMMDD`) and `nationality` (ICAO 9303), required on every entry when an issuance profile takes
      claims from the directory and reads a document (`directoryReadsDocuments`), optional `department`, `groups` and
      `roles`. Every scalar is read as text (YAML's failsafe schema: `0042` keeps its zeros, `NO` stays Norway). Ids and
      emails (lower case) are unique, roles declared, no other field allowed. A file that does not validate stops the
      start, naming each entry and field; the message never holds a birthdate or a nationality. A pack that writes the
      people inline (`identity.directory.people`, a list under `identity.directory`, `identity.people`) is refused in
      words, before the schema (`inlineDirectoryErrors`).
    - **Reload (IDENT-ROLE-013):** the directory of the file is watched, since a Kubernetes Secret is updated by a rename
      of the `..data` symlink in it, and the content is read every `DIRECTORY_POLL_SECONDS` (10; 0: watch only) and
      compared by its SHA-256, whatever the mount (no subPath assumption). A new version that does not validate is not
      loaded: the one in force stays, the log names the faults, and that content is not read again until it changes.
    - **What changed (IDENT-DIR-009):** each load is diffed against the last one into the admin audit, one record per
      entry added, removed or changed (`action: directory-change`, `actor: directory`, `reason: start | reload`):
      the id, the name, the names of the fields that changed, the roles before and after. The last load is kept in the
      key-value table, sealed, with keyed digests of the email, the birthdate and the nationality, never their values:
      what changed while the agent was down is recorded, and acted on, at start. Schema 3.7.0 gives the audit the order
      it was written in (`seq`), so that `GET {sessions}/admin/changes` pages newest first.
    - **Who holds an entry (IDENT-DIR-006):** the issuance record of a credential whose claims came from the directory
      names the entry (`directoryEntryId`) and a keyed index of the actor it identifies once presented (`holderIndex`:
      the home organization, the authentication schema, the subject key, D59); both are columns of `evidence` in 3.7.0.
      A presented identity credential of the home organization finds the newest such record that is not revoked, under
      the credential definition the presentation names (`PeopleService.entryOf`), and its Principal holds the entry
      (`Principal.directoryEntryId`). A Principal already identified as that actor holds it from the issuance. Its
      invitations to list spaces become `active` then (`SpaceService.bindDirectoryMember`).
    - **Roles by hand (IDENT-ROLE-002, IDENT-ROLE-014, D87):** a Principal's roles are those of its facts (`factRoles`:
      pattern, rules, overrides) with those of its entry. A rule that names `claims` does not match a Principal whose
      credential this agent issued from an entry; the relation keeps its rules, and the claims of badges issued by
      others keep theirs. A reload recomputes the roles of every holder; they hold from the next request, which reads
      the Principal again. `department` and `groups` give rule spaces their members (`SpaceService.directory`) and
      nothing else. A pack that no longer names a directory drops the roles its entries gave, and nothing else.
    - **Removal (D91, IDENT-LIVE-004/005):** the agent brings itself in line with the directory as loaded
      (`PeopleService.reconcile`, at start and after every reload). A Principal whose entry left loses it and the roles
      it gave, its identity credential's verdict turns invalid, and `onCredentialInvalid` closes every one of its
      sessions with `credential-invalid`, tells its wallet and unpairs its devices; all of this before any network
      call. Then every credential issued from the entry is revoked by its registry and index, an `admin_audit` record
      (`credential-revocation`) is written, and the holder is sent `revocation_notification` (INTX-FLOW-007) on the
      connection it was issued on and on its connection now, tried three times. A revocation the DIDComm agent refuses
      is kept with its error and made again every minute, and at the next start. An invitation of a person no longer
      listed is removed.
    - **Revocation, new:** the VS Agent takes the registry and the index from the caller at the offer under a revocable
      definition (VSA-ADM-DC-CE-OFFER) and does not report them; it revokes with `POST /v2/anoncreds/revoke-credential`
      and sends nothing to the holder, which the flow plugin does (`POST /v2/didcomm/revocation-notification`,
      `<registry>::<index>`). So `CredentialRevocations` allocates: one registry per definition at a time (capacity
      1000, the VS Agent's default), created with `POST /v2/anoncreds/revocation-registries` when there is none or the
      last is full, indexes from 0, the next index kept in the key-value table before the offer leaves, one allocation at
      a time. The definition of a schema is created with `supportRevocation` when a profile on it must be revocable
      (`mustBeRevocable`: its claims come from the directory, the only case the spec names); under any definition that
      supports revocation every offer carries a slot, which the record keeps (`revocation`). A credential from the
      directory is not issued without a slot (`not-ready`), nor when its holder cannot be told (the home organization
      not established).
    - **Spaces (SPACE-MEMB-001/002/004/005/007/008):** `POST {sessions}/spaces/{id}/members {directoryId}` adds a person
      of the directory, `active` when a Principal holds the entry, else `invited` (201 with the member; 404 for an
      unknown entry, 409 `already-member`); outsiders stay 501. A person removed while invited is removed, no longer
      `left`. `POST {sessions}/spaces/{id}/owner {directoryId}` gives a rule space to a person the rule matches who holds
      a Principal (422 `not-eligible` otherwise, and for `memberId` in a rule space or `directoryId` in a list space).
      A reload records `joined` and `left` in the rule spaces of a department or a group, with no `by`, for the
      Principals whose entry it moved; the owner and a former owner who keeps a member row are left out.
    - **Endpoints (PROF-DIR-001/003):** `GET {sessions}/directory?q=` (names and departments, at most 20, two
      characters at least, case and marks folded; `403 not-creator` to a person who owns no list space and may create
      none; an empty list without a directory). `GET {sessions}/admin/roles` and `GET {sessions}/admin/changes?before=
      &limit=` (`403 not-admin` without a role marked `admin`). People of the directory are named by its name in member
      lists, owners, activity and handovers.
    - **Profile package, aligned with §9 of spec #94** (the coordinator found drift): `ERROR_STATUS` lists every code
      with its status and `ErrorCode` is derived from it; `legal-hold`, `organization-not-accepted`, `not-on-verana`,
      `home-organization`, `email-unavailable`, `pairing-expired` and `pairing-invalid` were missing; the comments said
      409 `conversation-started` (the code is `has-messages`) and 400 for `out-of-bounds` (422). `forbidden`,
      `turn-in-progress` and `not-implemented` are kept, marked as the reference agent's beyond §9. The package carries
      the types of §3.9. `tests/profileErrors.test.ts` checks the codes and statuses of the routes, the space and session
      errors against the package and §9. No `features.spaces` or `features.memories` exists in the package.
    - **Choices of mine, to flag:** the 403 of the picker is `not-creator` (§9 gives no other for it); the admin change
      items carry their audit `id`, the cursor of `before`; the first load ever records every entry as `added`; the poll
      default is 10 seconds; a credential issued under a definition without revocation cannot be revoked and is logged
      once (no such badge from the directory is issued by this version); every definition an earlier version created
      has no revocation (it never asked for it), so on devnet the definition of the badge schema, if the agent created
      one, must be deleted in the VS Agent before badges are issued from the directory (not checked on devnet).
    - **Not done here (phase 2b):** the `record: directory` claim source and its loader rules (IDENT-DIR-002,
      INTX-ISSUE-021), the passport match (IDENT-DIR-003), the email code and `emailId` (IDENT-DIR-004, INTX-AUTH-011
      to 015, INTX-ISSUE-020), `as: dateint` (IDENT-DIR-005), SMTP (PLAT-MAIL), invitations (SPACE-INV) and
      `GET {sessions}/organizations` (PROF-DIR-002). The hook is `IssuanceDeps.record`, which resolves a claim of a
      system of record and names the entry. An offer left unanswered whose credential the wallet accepts later is not
      recorded (as before): such a badge would not be revocable by its entry.
    - **Tests:** `tests/directory.test.ts` (the file, the refusal of people inline, the diff, the sealed last load, a
      symlink swap seen by the watch and by the poll, an invalid reload, the picker), `tests/revocation.test.ts` (the
      allocation, a revocable definition, the offer, the issuance record of a badge from the directory),
      `tests/people.test.ts` (over the agent, with a mocked DIDComm agent and trust resolver: roles from the entry and
      IDENT-ROLE-014, the admin view, members by directory id, rule spaces by department and group, owner by directory id,
      a reload that changes roles, moves a person out of a rule space and removes two, revocation, its retry),
      `tests/profileErrors.test.ts`, and on PostgreSQL the migration to 3.7.0, the new queries, and the agent with a
      directory keeping nothing of a person in the clear but the id and the name the admin audit holds.
62. **A badge from the user directory, the email code, email, and invitations of other organizations: phase 2b**
    (2026-11-19, Fabrice's decisions of the design review, E5, E6, E7, review decisions 12 and 16; ayni-spec D88, D89,
    D90, PR #94). With it the build of spaces, memories, people and erasure is complete; one pull request carries
    decisions 60 to 62.
    - **The claims of the directory (INTX-ISSUE-002/021, IDENT-DIR-002/005):** a claim may read `{ from: record, record:
      directory, field }` (`name`, `firstName`, `lastName`, `email` or `department`, empty when the entry has none). The
      entry is found from the person's evidence, never before it exists: the claim is `pending` until then, its action the
      profile's own challenge (`issue_credential` with the profile and the `challenge`, `document` or `email`), and the
      credential `ready`; `missing` when no single entry is found, the reason in the log without a value
      (`DirectoryClaims`). The record of the issuance keeps the entry. `as: dateint` writes a date as `YYYYMMDD`;
      `emailId` numbers a badge by the verified address as `documentId` does by the document. The challenges of a profile
      are a list, run in order (`challengesOf`); a single object is still taken, as the spec's own §11.9 writes one for a
      document read. The loader refuses, in words, a profile of the directory with another list than `[document]`,
      `[email]` or `[document, email]`, a directory claim with no `identity.directory`, a passport whose match reads what
      `evidence.document` does not store, an email challenge without `evidence.email` storing `address`, with
      `modelVisible`, on a profile that takes nothing from the directory or on an automatic one, and an action that
      declares it (before the schema).
    - **The passport (IDENT-DIR-003):** the names of an entry are written as the machine-readable zone writes them, by the
      table of ICAO Doc 9303, Part 3, section 6 (`src/core/icao.ts`): every form the table gives for a letter, its base
      letter among them (`Müller` is `MUELLER`, `MUXXLLER` or `MULLER`; `Peña` is `PENA` or `PENXXA`; `ß` is `SS`), an
      apostrophe dropped, any other sign a separator. The last name equals the document's word for word; the words of the
      first name are words of the given names, in order (not necessarily side by side: `Ana Carmen` matches `ANA MARIA
      CARMEN`); the date of birth and the nationality (the zone's code, `D` for Germany) are equal. The document read does
      not keep its format, so the zone is taken to have filled its name field when the field it rebuilds is 30, 31 or 39
      characters long (TD1, TD2, TD3); then the last word it holds may begin the entry's, and a surname that filled it
      left no given name to compare. A letter with no Latin form never matches. The birthdate and the nationality never
      leave `UserDirectory.matchDocument`. The nationality comes from the chip's DG1, which the agent already reads
      (D73): nothing changes in the VS Agent.
    - **The email code (D89, INTX-AUTH-011..015, PROF-RUN-015, `src/core/emailCheck.ts`):** the issuing tool answers the
      model that the system asks the person and ends the turn (`ToolResult.endTurn`): the orchestrator calls the model no
      more, writes no empty reply, and streams the code's question as an `auth-challenge` entry. While the check waits in
      a conversation, `AyniAgent.turn` gives the person's messages there, from any device, to the code before anything
      else (one at a time per person): the address, then the tries. They and the code's answers are `auth-challenge`
      entries that start no turn and never enter the model's window, summary or recall (`entryToMessages` gives them
      nothing; they are not embedded); history shows them as messages. The answer to the address is one text; a code
      goes, in the background, only to an address an entry holds, so that neither the words nor the time of the answer
      tell which. Six digits (`randomInt`), kept as a keyed hash of the check and the code, ten minutes from its sending,
      five tries, used once; the address waits sealed in the challenge record and is dropped at its end. A right code
      records evidence `email` (`address`), and the issuance goes on by itself (`AyniAgent.continueIssuance`), the person
      told its outcome by the code; the model reads `Identity check (email) for issue_credential: passed | failed |
      expired` as a record of the system. A timer ends a check whose time is over, and the code says so; checks a restart
      left waiting resume. The platform rules (add-on 3.3.0) tell the model, when a profile has an email check, never to
      ask for an address or a code.
    - **Issuing identifies nobody (IDENT-RES-017):** a guest who receives the badge of the authentication schema is asked
      at once to present it (`IdentityRequests.request`, as the person's own request). When a guest identifies, what the
      agent verified about them and what it issued them follow them to the identified Principal
      (`EvidenceService.reassign`; PostgreSQL now updates `principal_id` of a record saved again): about-me shows the
      address, and the badge is `held`.
    - **Email (PLAT-MAIL-001/002, `src/platform/mail.ts`):** nodemailer 10.3.1, pinned, configured with the variables of
      the 2060.io website (Fabrice, 2026-11-19): `MAIL_HOST`, `MAIL_PORT` (587, STARTTLS when offered), `MAIL_ENCRYPTION`
      (`ssl`, or port 465: TLS from the start), `MAIL_USERNAME` and `MAIL_PASSWORD` (together, or neither),
      `MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME`; without `MAIL_HOST` and `MAIL_FROM_ADDRESS`, the email code is unavailable (its claims
      `unavailable`, INTX-AUTH-011) and invitations answer `503 email-unavailable`, which the agent says at start, naming
      the profiles and the templates. An email carries what its purpose needs and nothing else. `pnpm test:mail` sends
      through a throwaway Mailpit (`axllent/mailpit:v1.32.0`) and reads it back from its API.
    - **Invitations of other organizations (D90, SPACE-INV-001..005, PROF-DIR-002, `src/core/invitations.ts`):**
      `GET {sessions}/organizations?q=` searches the Verana Graph (`VERANA_GRAPH_URL`, `POST /v4/graph/search`, the `Did`
      surface, operators of kind `Organization`; key `org:<countryCode>:<registryId>`), one item per organization,
      trusted only, its name containing `q` (two characters at least, case and marks aside), the agent's own excluded, at
      most 20, to the people of the member picker. `POST {sessions}/spaces/{id}/members { organizationKey, email }`
      refuses, in this order, a key or an address that is not one (`400` with the field), no SMTP (`503`), the agent's
      own organization (`422 home-organization`), one the authentication does not accept (`409
      organization-not-accepted`), one the graph does not hold trusted (`422 not-on-verana`); then records an `invited`
      guest (the email sealed, its keyed index, the organization's name for the member list) and sends one email: who
      invites, the space, the agent and its organization, the badge needed, and the app link `<APP_LINK_BASE>service/<did>`.
      A Principal of that organization whose stored email matches is bound at once, asked nothing; one whose evidence
      holds none is asked once per invitation for its badge again, now when its wallet is connected, else at its next
      connection (`askedPrincipalIds`). A presented identity credential binds the invitations of its issuer's
      organization key (from the proof) and its `email`, in lower case, to its Principal, as `guest`. The agent warns at
      start when a list template exists and the authentication does not both ask for and store `email`, or when no
      `VERANA_GRAPH_URL` is set.
    - **Folded in from the integration check of the UI and the app (2026-11-19):** `GET {sessions}/spaces/{id}/shared` of
      a space that takes no handover answers `200 { conversations: [] }`, its messages 404 (it answered `409
      handover-not-allowed`, which §3.7 does not give). `turn-in-progress` is in §9 now (spec 84ec336); the profile
      package drops `not-implemented`, which no route answers any more. About-me names `email` as the source of a verified
      address and the issuing state as that of a document.
    - **Choices of mine, to flag:** `cancel` (or stop, annuler, cancelar, parar, abbrechen) stops an email check; a text
      that is not an address is asked again within the ten minutes and is not a try; every message while the check waits
      is taken, a voice note or a file included; the check is never served on a DIDComm chat (that is the capability
      channel): a badge asked from the wallet's own menu answers that the check runs in the app or the web; the outcome is
      told to the person by the code as a message of the agent; a guest who receives the badge is asked to present it; an
      invitation whose email cannot be sent is not recorded (`503`), and one whose organization the graph cannot be asked
      about is refused as not on Verana; without `APP_LINK_BASE` the link is on `app.ayni.org`; the first-name words of a
      passport match in order but not necessarily side by side; the zone's "filled" field is read from the length of the
      names, the format of the document not being kept.
    - **Found, not changed here:** the Principal keeps the stored claims of its identity credential in `identityAttributes`,
      in the clear in the `principals` table (decision 43): with `email` stored for invitations, the address is there. The
      messages of an email check are not ones a person can delete within the window (`TRANSCRIPT_MESSAGE_TYPES`). The
      reference profile names the indexer (`VERANA_API_URL`) for the search of organizations; the graph is its own
      service, `VERANA_GRAPH_URL` (a patch for spec #94 is handed over).
    - **Tests:** `tests/icao.test.ts` (the table, separators, other scripts, truncation, the match), `tests/directoryBadge.test.ts`
      (passport, email, both, `dateint`, `emailId`, the loader), `tests/emailCode.test.ts` (over the agent: pending claims,
      the turn that ends, one check at a time, the same answer, five tries, the right code and the offer, the badge
      presented and held, history and the model's requests, nothing in the clear, expiry by time and by timer, cancel,
      no SMTP), `tests/invitations.test.ts` (the graph search, every refusal, the email, binding, guests, the known
      Principal asked once), `tests/mail.test.ts` (the mailer, and Mailpit with `pnpm test:mail`), the shared list in
      `tests/spaces.test.ts`, `tests/profileErrors.test.ts`, and on PostgreSQL the invitations by keyed index and no
      address, code or invited email in any table. `pnpm e2e` (`scripts/e2e/spaces-people.e2e.ts`) runs the built agent
      on PostgreSQL with Mailpit and a stand-in that plays the DIDComm agent, the trust resolver, the graph and the phone:
      its report is in `scripts/e2e/report/`. A real VS Agent and a wallet are not part of any of them.
    - **Devnet (the deploy pull request):** the Dev Agent's credential definition of schema 23 was created without
      revocation: delete it in its VS Agent (`DELETE /v2/anoncreds/credential-definitions/{id}`) before a badge is issued
      from the directory. The flow plugin's `POST /v2/didcomm/revocation-notification` is in the plugin since its first
      release (`V2DidcommRevocationNotificationController`, registered by `AyniFlowPlugin`), so in the devnet image
      `io2060/vs-agent-ayni:v2.0.0-ayni.5-ayni.0.1.7`. New environment: `MAIL_*` (`MAIL_USERNAME` and `MAIL_PASSWORD` in a Secret),
      `VERANA_GRAPH_URL`.

63. **During an email check, only an address or a code is the code's; the model has a tool on the check** (2026-11-19,
    found by Fabrice on devnet with 0.24.0; ayni-spec D89 amended, INTX-AUTH-013/014 amended, INTX-AUTH-016..019,
    PROF-RUN-015 amended). The email never arrived (the SMTP server was misconfigured then); he typed "Resend the email"
    and the code answered "That code is not right. 4 tries are left." Every message was the code's while the check
    waited, and only the hidden word `cancel` got out. His words: "here it should detect it is not a code and pass it to
    the LLM, else I'm stuck".
    - **What the code takes (`carriedBy`, `src/core/emailCheck.ts`):** at the address step, a message that holds an email
      address, taken from the words around it ("my email is **Ana.Rios@Northwind.example**." gives
      `ana.rios@northwind.example`: the signs a sentence, a quote or markdown put around it are dropped, and the address
      is checked as before); at the code step, a message that holds six digits, side by side or split by single spaces or
      dashes (`482 913`, `482-913`, `4 8 2 9 1 3`), in a run of digits that is not longer, not part of a decimal number,
      and not a date or a phone number; at either step a message that is only a stop word (`cancel.` too). A message
      with two addresses, or two codes (`482913 or 123456`, or two groups of six in one run), is taken and answered with
      a request for one, and counts no try. A taken message is recorded and answered as before. **Any other message is
      the model's**: `take` returns before recording anything, `AyniAgent.turn` goes on as when no check waits, and the
      check keeps waiting; it counts no try. An address at the code step, or a code at the address step, is the model's.
    - **The tool `email_check` (`src/tools/bundled.ts`, INTX-AUTH-016..018):** in the model's list when an issuance
      profile declares an `email` challenge, whatever `tools.bundled` says (it has no switch of its own), for every
      Principal. `{ action: status | resend | cancel }`. `status` answers JSON: `waiting`, `conversation` (`this` or
      `another`), `credential` (the label), `step`, `secondsLeft`, `triesLeft`, `resendsLeft`, `resendInSeconds` at the
      code step. `resend` sends a new code to the sealed address (`EmailChecks.resend`): the hash of the previous code is
      replaced, `codeSentAt` and `expiresAt` start again, `resends` counts; refused before an address (`no-address`),
      after three (`limit`), within thirty seconds of the previous sending (`too-soon`, with the seconds). Its words and
      its limits do not depend on whether an entry holds the address; the code goes, in the background, to a listed
      address only, as at the address step. `cancel` ends the check as `failed`, as the stop word does: the address and
      the hash go, the model reads `Identity check (email) for issue_credential: failed` as a record of the system. The
      three run in the Principal's queue of the check, as `take` does. No answer and no `data` of the tool holds the
      address or the code.
    - **The words:** the platform rules (add-on 3.4.0) add "While one waits, email_check tells its step, sends a new code
      or cancels it."; the answer to the address adds "If it does not arrive, say so: a new one can be sent."; the
      issuing tool's `challenge-waiting` names `email_check`. The add-on with every feature, app links and an email check
      is about 835 tokens by our estimate (about 800 before, the language key of decision 64 included): over the 500
      target of CORE-PROMPT-004 already, as the orchestrator's warning says.
    - **Kept:** five tries in all for the check, whichever code they are for (a resend does not give five more); ten
      minutes from the last sending; the same answer to a listed and an unlisted address; the check on the store and its
      resumption after a restart (`resends` is one more field of the challenge's `details`, so nothing changes in the
      store); `cancel` and the other stop words.
    - **Choices of mine, to flag:** the tool also acts on a check that waits in another conversation of the person, and
      says so (`conversation: another`; a resend's answer says where to type the code); the tool exists for every pack
      with an email challenge, with no `tools.bundled` switch; the model's `cancel` writes no message of the code in the
      conversation (the model tells the person); an address typed at the code step goes to the model, which can `cancel`
      and call `issue_credential` again to use another address; a message whose only text comes from an attachment (a
      voice note's transcript, a PDF's text) is read as any message is, since that text is the message's.
    - **Tests:** `tests/emailCheckMessages.test.ts` (what a message carries; the tool in the list and the rule only with
      an email profile; over the agent: a message with no address and "Resend the email" reach the model and count no
      try, the address from a sentence, `status` here and from another conversation, a resend too soon, then sent, the
      first code a wrong try, the new one split by a space, nothing typed for the check in any model request, an unlisted
      address resent with the same words and nothing sent, the fourth resend refused, the resends kept by a check that a
      restart left waiting, two codes in one message, the model's `cancel` and the record it leaves);
      `tests/emailCode.test.ts` now expects a text with no address to reach the model. The store is not touched, so the
      PostgreSQL tests did not change.

64. **The email check's own messages, in the person's language, translated by the model with no context and kept**
    (2026-11-19, Fabrice's decisions; ayni-spec D94, INTX-AUTH-020..022, INTX-PREF-003, PROF-RUN-015 amended;
    `src/core/serviceLanguage.ts`). His five points: (1) the messages the code writes in an email check are translated by
    the model with no context, the request carrying the finished sentence and the target language only, never anything
    the person typed; (2) translations are kept per finished sentence and language, persistently, finished sentences and
    not templates; (3) no hand-written translations ship: the default message is in `language.agent`, the fallback
    when a translation fails; (4) the person's language is the preference `language` (a BCP 47 tag), else the session's
    locale, else `language.agent`, with no call when it is the text's language by primary subtag; (5) all in this PR,
    before 0.25.0.
    - **How point 3 is read (the coordinator's reading, flagged in both PRs):** the code's texts stay in English. When
      `language.agent` is not English, the default message is the English sentence translated (and kept) into it. When
      a translation into the person's language cannot be had, the message is in `language.agent`; in English only when
      even that cannot be had, which the log says (`a message of the service is shown in English`).
    - **The sentences:** every text `start()` and `take()` write (the question, the answer to the address, a wrong try,
      the last try, a right code, an expired code, two addresses or two codes, the stop) and the two endings `expire()`
      writes. `EmailChecks.text` renders each `ServiceSentence { text, keep }`: `keep` names the organization's name and the
      credential's label when the sentence holds them. The entries are as before (`auth-challenge`, the same payload);
      only their text is in the person's language, and the model reads them as the agent's (decision 65). The system record the
      model reads (`Identity check (email) for issue_credential: …`) stays English: it is the model's.
    - **The request (`ServiceLanguage.translate`):** two messages, a fixed instruction (`Translate the text of the user
      from English into the language whose BCP 47 tag is <tag>. It is a message a service shows to a person. Keep every
      number in digits. Keep these exactly as written: "<name>", … Answer with the translation only …`) and the sentence;
      no tools, no cache key, temperature 0, 400 output tokens at most, cut after 5 seconds. It goes to the agent's model
      only when the space of the conversation allows it (`SpaceService.providerRefusal`, as a turn does); its usage is
      logged (`model call`, `purpose: translation`) and counted with `purpose: translation` and no conversation: it is no
      part of a conversation's window or its measured context.
    - **The checks:** every sequence of digits of the sentence, as many times, and every part to keep, as written; an
      empty answer fails. A translation that fails a check, errs or takes too long is not kept, and the fallback applies.
    - **Kept (`translations`, schema 3.8.0):** one row per digest of the English sentence (sha-256) and language tag,
      with the sentence, the translation, the model and the time, in the clear: a sentence of the service holds no
      personal data. The first translation kept stays (`ON CONFLICT DO NOTHING`). Two identical requests at once in one
      process make one call. The in-memory store keeps them too.
    - **The language (`ServiceLanguage.languageOf`):** the preference `language`, read by the code through the scope
      predicate and logged as not shown to the model (`MemoryService.preferenceOf`), then `session.locale`, then
      `language.agent`. `principal_preferences` stores `language` only as a valid tag, in its canonical form (`fr_ca` gives
      `fr-CA`; a key `Language` is stored as `language`), and refuses anything else in words; its description and the
      platform rules (add-on 3.4.0, this PR) say so.
    - **Choices of mine, to flag:**
      - Translations are kept by the full canonical tag: `es` and `es-MX` are two translations, two calls. Only "is it the
        text's own language" and the fallback compare primary subtags.
      - A tag is what `Intl.getCanonicalLocales` accepts with a primary subtag of two or three letters, `und` excluded:
        `Spanish` is not a tag.
      - The instruction names the parts to keep (they are parts of the sentence), so that a translator does not render
        the label "Northwind badge" in its own words and fail the check.
      - `cancel` is not kept as written: a translated word to stop that is not one of the stop words reaches the model,
        which can cancel with `email_check`.
      - In a space that does not allow the agent's model, a translation already kept is used: it is no model call.
      - When `language.agent` is English and a translation fails, the English sentence is the default message: the log
        says why the translation failed, not "last resort".
      - Not translated, as out of the email check: the message of the issuance that follows a right code ("The
        credential is in your wallet." and its other outcomes, `issuanceOutcomeForPerson`), the refusal of a space that
        does not allow the model, and the greeting of the pack.
    - **Tests:** `tests/serviceLanguage.test.ts` (tags; the checks; the language order; no call for English in any
      region; the request with no context and its usage's purpose; kept and reused, by a new process too; the fallback
      chain on an error, a dropped number and a time out; the default language, translated, then English with a warning;
      an agent whose default language is Spanish; a space that refuses the model; over the agent: a check in Spanish by
      the session's locale, the entries unchanged and read by the model as the agent's, a kept question reused for another
      person, the preference stored as a tag and followed before the locale, and no address or code in any translation
      request or kept translation); `tests/postgres.test.ts` (the migration to 3.8.0: an agent whose default language is
      Spanish, its translations kept and reused by a new process with no call, and no address or code in the table).

65. **The model reads the email check's messages as the agent's; what the code took is withheld from it, a record in
    its place, and marked for the clients** (2026-11-19, Fabrice's decision after three designs for the bubbles;
    ayni-spec D95, INTX-AUTH-013 and MEM-RET-006 amended, INTX-AUTH-023, PROF-STREAM-011, PROF-HIST-013, UI-CONV-044,
    APP-CONV-045, UI-CONV-035 and APP-CONV-037 amended).
    - **The model's conversation (`Orchestrator.entryToMessages`):** a message the code wrote in an email check (role
      `agent`: the question, the answers, the endings) is an `assistant` message with its text, in the language it was
      shown in (decision 64). A message of the person the code took is a `user` message holding a record of the system,
      in the form every record has (`[system record, written by the system, not by the person and not by you: …]`):
      "the person typed their email address here; the code of the service took it for the email check, and it is not
      shown to you", with "a code", "more than one email address", "more than one code" or "a word that stops the email
      check" in the place of "their email address". What was typed is named by the entry's new payload field `carried`
      (`address`, `code`, `several`, `stop`), never by its content. The roles keep their order: the question
      (`assistant`), a record (`user`), the answer (`assistant`). Summaries render through the same function, so they
      hold the record too; neither kind is embedded for recall, as before.
    - **The mark (`EmailChecks.take`, `src/channels/agui/mapping.ts`):** as soon as the code records the person's message,
      it emits CUSTOM `ayni.messages.withheld` `{ conversationId, messageIds: [id], clientIds?: [externalId] }` in the run;
      the run's mirror gives it to every other bound session of the conversation, as it does every event of a run.
      History gives that message `metadata.modelVisible: false` (`isWithheldMessage`); no other message carries the field.
    - **The profile package (`@ayni.org/ayni-agui-profile` 3.3.1):** `CUSTOM_EVENT.messagesWithheld`,
      `MessagesWithheldValue`, `MessageMetadata.modelVisible`; the descriptor's `profileVersion` stays `3.3`.
    - **Choices of mine, to flag:**
      - The record's wording above, and the `user` role, as every record of the system has.
      - The stop word and a message with two addresses or codes are marked too: they are messages the code took, and the
        model never received them (the record names them without their content).
      - Only the messages an email check took are marked: the person's messages in a space that refuses the agent's model
        are not, since they are ordinary entries a later turn may give the model.
      - The package is a patch release (3.3.1), as the amendments of 3.1 were, and `profileVersion` stays `3.3`: the
        event and the field are additive, and a client that ignores them keeps working.
    - **Tests:** `tests/emailCode.test.ts` (history marks the three messages the code took and none of the code's; the
      model's request holds the code's messages as `assistant` messages and one record per message taken, in order, and
      no address or code), `tests/emailCheckMessages.test.ts` (the event in the run and on another device of the
      conversation, with both ids; none for an ordinary message; the code's messages in the model's request),
      `tests/serviceLanguage.test.ts` (the Spanish messages in the model's request).

66. **Tools, phase 1: the catalog, tools in spaces, call rules and provenance** (2026-11-20, Fabrice's decisions TA1 to
    TA11 of the tool access review; ayni-spec PR #99, D96 to D100, D41 and D80 amended, TOOL-ACCESS-001 withdrawn;
    CORE-PACK-001, TOOL-ACCESS-002..007, TOOL-CAT-001..009, TOOL-AVAIL-001..006, TOOL-SPACE-001..011, TOOL-CALL-001..010,
    TOOL-PROV-001..006, RBAC-FILTER-004, INTX-APPR-004/005/012..015, SPACE-MEMB-008; AG-UI profile 3.4).
    - **The catalog (`src/tools/catalog.ts`, `src/config/pack.ts`):** every MCP server, HTTP tool and key of
      `tools.bundled` is a source with a title, an account (`none`, `agent`, `space`), an availability (`agent`,
      `personal`, `spaces`), its offered tools, its bindings and the effect, rule and trust of each tool. Effects come
      from the pack, else the MCP annotations with MCP's defaults, else the HTTP method; rules from a
      `toolAccess.approval` entry, else the pack, else the effect. `personal` and `organization` accounts, unknown values
      and shared names are refused before the schema, in words naming the source and the field; the cross-field rules
      refuse what TOOL-CAT and TOOL-AVAIL-002/003 refuse and warn of a source of spaces no template names and of a rule
      of approval nobody approves.
    - **The turn's tools and the gate (`src/core/toolGate.ts`):** a turn takes its tools once (TOOL-AVAIL-006), narrowed
      in code to the offered tools of the sources available in the conversation's space, a source of a space only when
      `ready` and not `off`, guests only where the template opens it, pinned arguments out of the schemas. Each call goes
      through the confirmation, the approval, the liveness, the step-up and the call, in that order; untrusted content
      raises a card with no allowance; the result is scrubbed of the space's token (`[account]`) before anything records
      or reads it; the `tool-call` entry carries its provenance in the clear; every call leaves a `ToolCallRecord`.
    - **Confirmations:** an approval record of kind `confirmation`, its card (`ayni.approval`, `kind: confirmation`) in
      the run and mirrored to the conversation's other sessions, waited for in the turn; `approval.decide` decides it
      from any session of the conversation with `noTurn: 'decision'`; expiry (`approvals.confirmation.timeoutSeconds`),
      a stopped reply and a new message cancel it; "Allow for this conversation" makes a `ToolAllowance`, ended by
      `DELETE …/allowances/{id}`, an archive, or a change of the source's rule, bindings or account.
    - **Approvals of tool calls:** the action as its card shows it (`action`, sealed with the arguments under a key of the
      record, `sealedApprovals`); a tool of a space approved by its owner at decision time (`ownerApproval`, attested, an
      `authorize` flow whose purpose, justification and scope follow INTX-APPR-013); the owner asking in his own space
      gets his own confirmation; approved, the call runs with the bindings and account in force and its outcome is told.
    - **Tools in spaces (`src/core/spaceTools.ts`):** the state per space and source, the owner's endpoints of §3.10, the
      space account sealed as it arrives and opened only for a call, a granting change held behind a `device` challenge
      sent as a `confirm` flow with no conversation and no card (`ChallengeService.confirmChange`), narrowing changes at
      once, `ayni.space.tools.changed` to the owner's sessions, the space's activity, the alignment with the templates at
      start, ownership transfer.
    - **MCP:** `offer` filters what the model is given (warned once of a name the server lacks); a server of space
      accounts keeps one connection per space, opened on first need and closed after `TOOL_CONNECTION_IDLE_SECONDS`.
    - **Provenance:** `sources` on every message of a turn that ran tools of MCP servers or HTTP tools (`metadata.sources`
      in history, own and shared), the same sources in `GET {sessions}/conversations/{id}/sources`; never a bundled tool
      (memory, knowledge search, the email check, reactions), whose entries keep their provenance with `sourceKind:
      bundled`. `GET /admin/audit/tool-calls` for auditors (each read recorded).
    - **Settled with the spec after review (2026-11-20):** the requester of every card is `{ displayName, role }`; a
      `PATCH` that only narrows applies at once even while a granting change waits for the phone, and `409
      change-pending` answers only a request that grants something; the member's view of a space's tools lists only the
      tools members can use, none set `off`; bundled tools are no sources of a reply or a conversation.
    - **Store (schema 3.9.0):** `space_tools`, `space_accounts` (the token only as ciphertext, its key in the row),
      `tool_allowances`, `tool_calls`.
    - **Choices of mine, to flag:**
      - A bundled tool that no key of `tools.bundled` enables (`knowledge_search`, `set_reaction_policy`, `email_check`) is
        a source of its own name, for its rule and its call record.
      - Step labels say `Using <source title>` when the pack gives the source a title, and `Working` otherwise: never a
        tool's name or description.
      - The code of a change is two groups of two digits ("48 21"); the summary reads "Add X to S", "Change X in S: …",
        "Set (Replace) the account of X in S", with every binding and rule of the change and never the token.
      - A call record is written when the model asks, with the outcome `pending` while another person's approval waits.
      - Arguments are validated before an approval as well as before a card; a server's `$schema` is ignored to validate.
      - The tools of a server of space accounts are discovered on the first space connection and shared by every space
        (definitions only); before any account exists, the settings list `offer` with the pack's effects and rules.
      - The rules and the list of a turn are its start's; the bindings and the account are read at the call.
      - An allowance carries a fingerprint (rule, bindings, when the account was set) checked at use, and ends when the
        owner changes the source.
      - `approval.decide` keeps its 3.3 answer for an approval decided by an approver; only a confirmation gets
        `noTurn: 'decision'`.
      - The arguments of every approval are now sealed in the store (they were in the clear in the approvals JSON).
      - An approval asked before this version and approved after it does not run; the person is told to ask again.
      - An attested request no longer opens an `authorize` flow on the requester's own phone.
      - The platform rules' tools line is replaced, when a tool may ask, by one that says so (add-on 3.5.0), to stay
        within the token budget.
    - **Tests:** `tests/toolCatalog.test.ts` (the pack, effects, rules, trust, the offer, one connection per account),
      `tests/tools.test.ts` (over the agent with fake MCP and HTTP servers, a scripted model and a stubbed phone: the
      settings, the phone's confirmation, the account, the tools of a turn, the card and its decisions, allowances,
      untrusted content, rules, the owner's approval, provenance, the admin read, deletion within the window),
      `tests/postgres.test.ts` (the migration to 3.9.0 and the new tables).
67. **Tools in one map: every tool source is one entry of `tools.sources`** (2026-11-20, Fabrice's decision; ayni-spec
    PR #100, D101, D96 and D99 amended; CORE-PACK-001, IDENT-LIVE-011, RBAC-TOOL-001, TOOL-HTTP-001/002,
    TOOL-CAT-001/006..011, TOOL-AVAIL-002/003, TOOL-SPACE-006, TOOL-CALL-001, INTX-AUTH-002). Nothing changes on the
    AG-UI wire: profile 3.4, the source ids, the space-tools endpoints and the cards are as they were.
    - **The pack (`schemas/agent-pack.schema.json`, `src/config/packTypes.ts`):** `tools.sources` is a map keyed by the
      source id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`). Each entry is `$defs/toolSource`: `type` (`mcp`, `http`,
      `bundled`), the common fields (`title`, `description`, `account`, `availability`, `access`, `tools.<name>` with
      `title`, `effect`, `call`, `untrusted`, `stepUp`), and, through `if`/`then` on `type` with
      `unevaluatedProperties: false`, the connection of its type: `mcpSource` (transport, url, command, args, env,
      headers, lazy, reconnect, offer, bindings, untrusted), `httpSource` (description, method, url, headers,
      parameters, bodyTemplate, timeoutSeconds, bindings, untrusted), `bundledSource` (bundled, enabled, endpoint,
      defaultStatClass, provider). `stepUp` is `{ authChallenge, maxCredentialAge }`, what `actions.<tool>` held.
      `mcp`, `tools.http`, `tools.bundled`, `tools.access` and `actions` are gone from the schema.
    - **The loader (`src/config/pack.ts`):** the withdrawn keys are refused before the schema, one line per key found,
      each naming the key that replaces it (`withdrawnToolKeyErrors`, TOOL-CAT-011). The checks in words are kept:
      `catalogValueErrors` (type, values, bundled names, an HTTP tool's `tools` naming its own tool only, a bundled
      tool's own tools with no effect and no trust), `reservedAccountErrors`, and `emailChallengeStepUpErrors` (the
      email code on a step-up). The cross-field rules check each source's `access` against its own tools: an HTTP
      tool's, a bundled tool's, or, for an MCP server, at discovery. A face match on a step-up needs
      `media.faceVerification`, and the image provider is read from the source that names `generateImage`. The
      coercion now follows the `if`/`then` branch of a source's type, so `offer: ${OFFER}` and
      `timeoutSeconds: ${T}` still coerce.
    - **The readers:**
      - the catalog builds its sources from the map, the bundled ones from the source that names them, else under
        their bundled name;
      - `stepUpOf(source, tool)` replaces `pack.actions[tool]` in the gate (liveness, then the step-up) and in the
        settings of a space (`stepUpTypeOf`);
      - the MCP and HTTP sources take `[id, entry]` and the source's `access`;
      - the bundled tools read `bundledEnabled` and their source's `access`;
      - the orchestrator reads requestable tools and step-ups from the sources.
    - **Packs migrated:**
      - `agent-packs/dev`: `echo` and `wire_money` each carry their own `access`, and `wire_money` its `stepUp`;
      - `agent-packs/example`: the CRM's `access` and the step-ups of `issue_refund` and `read_customer_record`;
      - `agent-packs/welcome`: three bundled sources, no `access`. Its old `tools.access` gave nothing, since its
        roles listed no tool and the bundled tools never read it.
      - The tests' fixture pack and `scripts/validate-agent-pack.py` follow.
    - **Choices of mine, to flag:**
      - An HTTP source is one tool, named by the source's id; its `tools` may declare that one only.
      - A bundled source names its bundled tool with a required `bundled`; its id may differ (`notes`). Only one
        source may name a given bundled tool.
      - Declaring a bundled source turns it on. `enabled: false` turns off one that is on by default.
        `statistics: { enabled: false }` and `{ enabled: true }` for a default-on tool are now just "not declared"
        and "declared".
      - A bundled tool that acts on the person's own records stays open to every Principal (`default: all`) while
        its source declares no `access`. When the source declares one, it applies. `statistics` and
        `generate_image` are denied unless their source's `access` lists them, as they were unless `tools.access`
        did.
      - `untrusted` may now be declared per tool by an HTTP tool too; a bundled tool declares neither `effect` nor
        `untrusted`.
      - `offer` and `bindings` stay with MCP servers and HTTP tools as in phase 1. `preset` is not built, and the
        schema refuses it as an unknown key until presets come (O32).
    - **Tests:**
      - `tests/toolSources.test.ts` (new): the withdrawn keys refused with their replacements; one entry per
        source; coercion through the type's branch; another type's key refused; a step-up kept to its source when
        two sources share a tool name; bundled sources (another id, on and off, access, refusals).
      - `tests/toolCatalog.test.ts`, `tests/tools.test.ts` (the step-up now set in the CRM's source),
        `tests/directoryBadge.test.ts` and `tests/welcomeReissue.test.ts` follow the map.
68. **A space's account in named fields, one masked field per key** (2026-11-20, Fabrice on devnet, setting X for a
    space: "There should be one field per key/attribute."; ayni-spec PR #103, D102, D97 amended; TOOL-ACCESS-003..006,
    TOOL-CAT-002/012, TOOL-SPACE-002/005/007..011; AG-UI profile 3.4 amended in place, PROF-TOOL-001/004).
    - **The pack (`schemas/agent-pack.schema.json`, `src/config/packTypes.ts`):** a `space` account declares `fields`
      (`$defs/accountField`: `name` `^[a-z][a-z0-9_]{0,31}$`, `label`, optional `pattern`) and `apply`
      (`$defs/accountHeader`: `header`, `value`, no control character), each a list of one or more. `label`,
      `pattern` and `apply` as one object are gone from the schema.
    - **The loader (`src/config/pack.ts`):** `withdrawnAccountKeyErrors` refuses the former keys before the schema, one
      line per key, each written with its replacement built from what the account declares (`fields: [{ name: token,
      label: API token }]`, `apply: [{ header: Authorization, value: "Bearer {token}" }]`; TOOL-CAT-012). The cross-field
      rules refuse a space account without `fields` or `apply`, two fields of one name, a field's pattern that is not a
      regular expression, a header declared twice, a value that names a field the account lacks, a field no header names,
      and `fields` or `apply` on an account that is not a space's.
    - **The endpoint and the store (`src/core/spaceTools.ts`, `src/channels/agui/routes.ts`):** `PUT …/account` takes
      `{ values }`. Every field and no other (`400 bad-request`, `field: account.<name>`, or `values`); each value trimmed
      of the whitespace at its ends, then `422 bad-token` at its field when not a text, empty, longer than 4096, with
      whitespace or a control character (`\p{Cc}`) inside, or off its pattern; the first refused in pack order is named,
      and no message carries a value. The trimmed values are sealed together, `{ values }` under one key, in the
      pending change (`sealedValues`, was `sealedToken`) and then in `space_accounts`. No table changes, so no schema
      migration: the store stays 3.9.0.
    - **What was sealed before:** at start (`align`), an account whose sealed values do not fit the fields its source
      declares is destroyed and logged by space and source; this covers every single-token account of 0.27.0, and an
      account set before the pack changed its fields. The owner sets it again; the source reads `setup`. A pending
      account change whose values no longer fit when the phone confirms is dropped as `failed`.
    - **The call (`src/tools/accountValues.ts`, `mcp.ts`, `http.ts`, `toolGate.ts`):** `openAccount` builds the headers of
      `apply` from the values at the call (`buildAccountHeaders`) and hands the call `{ headers, secrets }`; nothing logs
      either. An MCP server keeps one connection per space, told apart by a SHA-256 of its headers, not by the values. An
      echo is scrubbed of every value and every built header, the longest first (`scrubAccount`, which replaces
      `scrubToken`), so `Bearer <token>` now reads `[account]` whole.
    - **Profile package 3.4.1:** `SpaceTool.account.fields` (`SpaceAccountField`), `SpaceAccountRequest.values`.
    - **Choices of mine, to flag:**
      - Whitespace inside a value is refused whatever the pattern, and so is a control character.
      - Unknown names are checked first, then missing fields, then each value in pack order.
      - Every `{...}` in a header's value is a placeholder, so a misspelt field is refused at start rather than sent
        as text.
      - The former form's refusal suggests one field named `token`, with the former label and pattern. For an account of
        several keys, such as X's, the operator splits it by hand.
    - **Packs migrated:** none of `agent-packs/` has a space account. The tests' fixture pack migrates the CRM and the
      post to X to one field each, and adds `x_mentions`, an HTTP tool of the four keys of X in one header. The docs
      carry the X example and a single-token one. The Dev Agent's devnet pack (ayni-deploy) is refused as it is, and
      loads once its X source is given the four fields.
    - **Tests:** `tests/toolCatalog.test.ts` (the former keys refused with their replacement; a header naming a field
      the account lacks; a field no header names; two fields of one name; a header twice; a bad pattern; `fields` on an
      agent account; the schema's name and line-break rules; four fields to one header; a single token to
      `Authorization`; the scrub of the header and of each value). `tests/tools.test.ts` (the owner's view of the fields;
      400 for a missing, unknown or former body; 422 at the field for off-pattern, CR/LF, space and control character;
      a value with a space before it or a line break after it taken trimmed; the phone's confirmation as before; the
      X-Account header built at the call; the echo scrubbed; a single-token account of 0.27.0 dropped at start; and the
      whole file run with a debug logger whose output holds no value of any account). `tests/postgres.test.ts` seals
      the four keys together.
69. **A link over a new connection is asked as a reuse is, and the phone shows the code on every link** (2026-11-21,
    found by Fabrice on devnet; ayni-spec PR #105, D5 amended, CHAN-BIND-009 amended, CHAN-BIND-017; supersedes the
    `outOfBandId` of a new connection in entry 3).
    - **As seen:** on the Welcome agent, the phone removed the service (DIDComm hangup), the web UI unlinked and showed
      a new code, the phone scanned it. The VS Agent logged a DID Exchange `request` and `complete` (a new connection),
      the agent resolved a guest, told it where it stood and gave it a session grant, and sent no `link-session`
      request: the browser's code stayed on screen forever. The same hits anyone who links the web UI before their
      phone ever connected to the service. A phone that reuses its connection links fine.
    - **Cause:** since verana-labs/vs-agent#804 (2026-10-19) a VS Agent connection carries no `outOfBandId`; it names
      its invitation as `invitationId`, and only when the invitation is an invitation record. The agent minted with
      `POST /v2/didcomm/out-of-band` and read `record.outOfBandId`, which was always undefined, so `onConnection` never
      called `onInvitationAccepted`, silently. The reuse event still names the Out-of-Band record (`outOfBandId`),
      which is why that path worked. The phone does answer the QR's own invitation: the Ayni app accepts it with
      `receiveInvitationFromUrl`, and Credo's DID Exchange request names the invitation `@id` as its parent thread.
      The recipient key differs from the reuse's because a reuse travels on the existing connection and a new request
      goes to the agent's public DID, which the invitation names in `services`. It is not an implicit invitation. The
      VS Agent's description of `POST /v2/didcomm/out-of-band` still says its connections carry `outOfBandId`, which is
      stale. That is not changed here.
    - **Fix:**
      - `DidcommAdapter.mint` now mints a standalone invitation record (`POST /v2/didcomm/invitations`, DIDComm v1,
        single use, the binding goal code). The record id is the session's `outOfBandId`, and the invitation's `@id`
        is its nonce, as before.
      - That call answers the invitation and a short URL (`{base}/s?id=…`), which the Ayni app does not read. So
        `invitationUrlOf` writes the `oob=` URL as Credo does, on the short URL's base, which is the VS Agent's public
        URL. `oobUrl` and `walletLink` keep their form.
      - A completed connection with `invitationId` goes to `onInvitationAccepted` as a reuse does.
      - An invitation that names no provisional session is logged as a warning, with the state of any session that
        holds it (`an accepted invitation names no provisional session`). A connection that names no invitation
        logs nothing.
      - `ConnectionRecord` reads `invitationId`, no longer `outOfBandId` (no fallback: the team is the only tester).
    - **Three codes on every link** (Fabrice: so that the person can verify the code):
      - `askLinkSession` always sets `codes`, the session's code and two decoys (`codesAround`, moved to the adapter),
        and returns them. Its callers no longer pass codes.
      - The answer to the binding question binds only on `link: true` with the session's code, whitespace and case
        aside, as the known-device re-link did. Any other answer leaves the session provisional and closes the flow
        `cancelled` with "Not linked."
      - A wallet without flows keeps the question-answer message, which already names the code.
      - The Ayni app already renders `codes` ("Tap the code the browser shows.") and answers with the code tapped, so
        it needs no change.
    - **Side effect, to flag:** a standalone invitation record carries no label and no image (the VS Agent ignores
      both for one). The Ayni app names a service from its trust resolution, not from the label. A wallet that shows
      the label of an invitation, such as the Hologram App, shows none.
    - **Tests:** `tests/bindingInvitation.test.ts`, with the events exactly as VS Agent 2.x writes them:
      - the mint call, and the `oob=` URL decoding to the invitation;
      - a new connection naming its invitation record asked the link question with three codes, and the browser's
        code binding it;
      - the reuse path unchanged, with codes;
      - an unknown invitation, and a reuse of a linked one, each logging the warning and asking nothing;
      - a connection that names no invitation, logging nothing;
      - a wrong code, and no code, leaving the session provisional;
      - the right code with spaces and in lower case binding;
      - `codesAround` giving three distinct codes, the real one among them.
    - **Without the fix:** with `src/channels/didcomm/events.ts` of main, 5 of the 11 fail. The first is the
      reproduction: no `link-session` request is sent ("expected [] to have a length of 1").
    - **Other tests:** `tests/flows.test.ts` answers with the session's code and checks the codes on the scan path.
      The connection events of the other tests and of `scripts/e2e/spaces-people.e2e.ts` take the 2.x shape
      (`invitationId`), and the e2e stand-in answers `POST /v2/didcomm/invitations`.
70. **A turn's speed: no call to close a turn, what the agent keeps after the history, every call timed** (2026-11-21,
    Fabrice's "go" on fixes 1 to 3; ayni-spec PR #106, D103, D75 amended, CORE-MSG-012, MEM-CTX-007, LLM-USAGE-004,
    MEM-CTX-001/004, LLM-USAGE-002 and LLM-CACHE-002 amended).
    - **As seen:** on devnet (Kimi) the Dev Agent's last three replies took 8, 9 and 17 seconds, in 2, 3 and 4 model
      calls of 3 to 7 seconds each. The model called 1, 2, then 3 tools, and every turn also saved a memory. Only about
      1,792 of the 6,000 to 6,500 input tokens of each turn's first call were cached; the later calls of a turn were
      (5,600 to 6,600). The logs held token counts, not durations.
    - **Causes:** an answer holding the reply and only memory or preference saves still got one more model call, to
      close the turn. The preferences and the notes were the third system part, before the history, so each memory
      saved changed the request from there on, and the provider read the whole history again.
    - **No call to close a turn (`src/core/orchestrator.ts`):**
      - `isMemorySave` names a save by the tool's key: `bundled:working_memory` (any action), or
        `bundled:principal_preferences` with `action: set`. A read of the preferences is not one.
      - When the round's text is not empty and every call of the round is a save, the loop ends after the calls, once
        each of them came back `completed`.
      - A save that failed, was declined on a card, or waits for an approval keeps the loop, so the model reads why.
        So do an answer with no text and a call of any other tool.
      - `ToolGate.execute` now returns `{ content, outcome }`, the outcome of the call's record.
      - Nothing else changes: the `tool-call` entries, the reply and the memory lines (`ayni.memory.updated`) are
        recorded as before. The next turn's history holds each call and its result, then the reply, which every
        adapter takes.
    - **What the agent keeps, after the history:**
      - `systemMessages` keeps three system parts: the persona, the add-on, and who the person is (name, roles,
        channel).
      - `keptRecord` writes the preferences and the notes of the space as one `[system record ...]`.
        `withRecords` puts it at the start of the turn's message, before the recall record and the words.
      - It is read once per turn, as the tools are, and counted in the budget with the message.
      - It sits there, not as a trailing system message, because `toOpenAiMessages` merges every system message into
        one at the top (several compatible endpoints honour only the first), Anthropic takes one top-level system
        prompt, and Bedrock Converse refuses two user messages in a row. Roles stay in a system part, out of reach of
        a person who types a fake record.
      - The stub strips every leading record before it echoes.
    - **Every call timed (`src/llm/timing.ts`):**
      - `measured()` wraps a call's stream. It takes the time to the first `started`, `text` or `tool_call` delta,
        the duration, the stop reason, the usage, the number of tool calls, and the outcome (`completed`, `failed`,
        `cancelled`).
      - `callLogFields` gives the line's fields: numbers, the provider and the model, and never content or tool names.
      - Two new deltas: `started` (first token of text, reasoning or a tool call) and `stop` (the provider's own
        reason). The adapters send them:
        - OpenAI-compatible: `content`, `reasoning_content` or `tool_calls`, and `finish_reason`;
        - Anthropic: the first `content_block_start`, and `stop_reason`;
        - Bedrock: the first block, and `messageStop.stopReason`;
        - Ollama: `content`, `thinking` or `tool_calls`, and `done_reason`.
      - The turn's line (`model call`) adds `provider`, `firstTokenMs`, `durationMs`, `stopReason`, `toolCalls` and
        `outcome`. `model` is now the model's own name, not `provider/model`.
      - The summary and translation calls log the same line per call. The summary's old aggregated line is now
        `conversation summary made`.
      - The image describer still logs nothing (it never did).
    - **Tests:** `tests/turnSpeed.test.ts`:
      - a reply plus a note saved makes one call, keeps the note and shows the memory line;
      - a note and a preference saved together make one call;
      - a read of the preferences, a save with no reply, a failed save, and a save beside another tool make two;
      - the next turn's request, written by each of the four adapters, answers every call right after it, and for
        Anthropic and Bedrock alternates user and assistant;
      - after a turn that saved a note and a preference, the next request repeats the system parts and the history
        byte for byte, with the record only on its last message;
      - the stub's cache serves the next turn through the history;
      - the log line's fields hold none of the person's words, the reply, the note or the tool's name;
      - `measured` tells a failed and a cancelled call once each, and each adapter sends `started` and `stop`.
    - **Without the change:** with the loop of main, the three one-call tests fail ("expected ... to have a length of
      1 but got 2"). With the block back in the third system part, the prefix, cache and spaces tests fail. With
      main's log line, the log test fails (no `provider`). The history test passes on main too: it guards the shape
      the early end leaves.
    - **Other tests:** `tests/agui.test.ts` (CORE-MSG-011) and `tests/turns.test.ts` (two calls of a turn) now use a
      read tool, since a preference set or a note added with text now ends the turn. `tests/spaces.test.ts` reads the
      notes from the turn's message, and checks that no system part holds them.
    - **Still breaking the cache, not changed here:**
      - the tool list changes with elevation grants;
      - flow and confirmation cards rewritten in place change their record in the history;
      - the identity part changes when the person is identified or their roles change;
      - the previous turn's message, which carried the records, is read again uncached once.
71. **No answer of the profile is stored: `Cache-Control: no-store`** (2026-11-21, found by Fabrice on devnet;
    ayni-spec PROF-ERR-003, UI-SESS-020; ayni-ui decision 43).
    - **As seen:** in Chrome on his Mac, the web UI linked to the Dev Agent never showed his spaces and showed one of
      his two conversations, for hours, after clearing cookies and site data and after linking again. A fresh
      Incognito window worked at first, then broke the same way. The phone was not affected.
    - **Cause:** the web UI reads the list with `GET {sessions}/conversations`, the same URL for every session; the
      token travels in `Authorization`, which is no part of the browser's cache key. The routes sent no
      `Cache-Control` (only `vary: origin`), and Chromium holds a `410` with no freshness of its own as fresh for ever
      (`HttpResponseHeaders::GetFreshnessLifetimes` treats `300`, `301`, `308` and `410` so). Once the browser got
      one `410 closed` for the list (a session a supersede closed), it answered every later list from its cache with
      that `410`, whatever the token, without asking the agent; only the CORS preflight went out. The UI reads the
      spaces after the list succeeds, so they never showed. The devnet ingress logs show `OPTIONS
      /agui/v3/sessions/conversations` and no `GET` from 16:15 to 18:39 UTC, but one, at 18:37:38, answered `410`.
    - **Fix:** one `onSend` hook in `AgUiRoutes.register` sets `Cache-Control` on every answer whose path is the
      descriptor, the sessions base or a path under it (`isProfilePath`, the query aside), routes and not-found
      alike, errors included (`401`, `403`, `404`, `409`, `410`, any `4xx` or `5xx`, the error handler's too). The
      value is `cacheControlOf(status, routeValue)`: `no-store`, except a `200` whose route set
      `private, max-age=N`, which the two attachment routes do and keep. An error of those routes is `no-store`, even
      after the header was set.
    - **The descriptor** is `no-store` too: nothing says it may be cached, and the UI reads it again for features and
      limits that change with the agent (`refreshDescriptor`). It is public, so the reason is freshness, not privacy.
    - **The two streams** (the session stream and a run's response) write their head on the raw response, which no
      hook sees. They move from `no-cache, no-transform` to `no-store, no-transform`: `no-cache` lets a cache store
      the stream and only asks it to check before using it, and the stream is authenticated content.
    - **Not changed:** the DIDComm callbacks (`/media/:token`, `/vision/*`), A2A, `/health/*`, `/stats` and
      `/integrity/anchors` are not of the profile and keep their headers; the CORS preflight answered under the
      sessions base gets `no-store` as well, which changes nothing (a preflight is cached by
      `Access-Control-Max-Age`). A client that adds a cache-busting query parameter (React Native's `fetch` adds
      `_=<time>` to a `GET` in `no-store`) is answered as before: no route reads parameters it does not know.
    - **Headless Chrome 158** (`gone-nostore.cjs`, a local API that answers `410` for one token and `200` otherwise):
      with the headers of main, the calls with two other tokens get the cached `410` and never reach the API. With
      `Cache-Control: no-store` on the answers they reach it and get `200`, and so they do with `cache: 'no-store'` on
      the calls. A browser that cached the `410` before the agent sent `no-store` keeps serving it to default-mode
      calls; the UI's `no-store` calls (ayni-ui decision 43) reach the agent then.
    - **Tests:** `tests/noStore.test.ts`:
      - a `410 closed` for the list of a session a supersede closed, a `200` list and the spaces, each `no-store`;
      - `401` (no token, a wrong one), `403 not-bound`, `404` (another session's id, a path no route takes) and `409`
        (a binding refresh too early), each `no-store`;
      - an attachment's `200` keeps `private, max-age=300`; its `404`, `401` and `410`, and the `404` of a shared
        conversation's attachment, are `no-store`; the upload's `201` too;
      - the descriptor, a run's stream (`no-store, no-transform`) and a refused run (`400`), and the session stream
        read over a real connection (`no-store, no-transform`);
      - `/health/live` keeps no `Cache-Control`;
      - `cacheControlOf` for every status and value, `isProfilePath` for the paths in and out.
    - **Without the change:** with the hook removed and the streams back to `no-cache` (the two helpers kept), 6 of
      the 9 fail, each on its first `Cache-Control` ("expected undefined to be 'no-store'"); the `/health/live` test
      and the two tests of the helpers pass.
72. **Tools, phase 2: each person's own accounts** (2026-11-21, Fabrice's decisions TA1 to TA11 of 2026-11-20, "start the
    phase 2 spec" and the Relaticle workspace of 2026-11-21, ayni-spec PR #107 merged; D104 to D110, profile 3.5).
    - **The kind `personal`** (`account.kind`, TOOL-CAT-002/013): `oauth` for a remote MCP server, `fields` and `apply`
      for a personal API token (an MCP server or an HTTP tool), or `from`, another source's account at the same URL;
      `check`, `binding` and `tokenPatterns` beside them. Only `organization` stays refused. Any availability; never
      `stdio`. Refusals name the source and the field (`pack.ts`, `personalSourceErrors`, `personalAccountErrors`).
    - **OAuth as MCP defines it** (`tools/oauth.ts`, revision 2026-07-28): the Protected Resource Metadata from the
      `resource_metadata` of a `401` to an MCP `initialize` without a token, else its well-known URIs; its `resource`
      must be the source's URL (scheme and host in lower case, one trailing slash aside); the authorization server's
      metadata at the RFC 8414 then OpenID URIs, its `issuer` exact, `S256` required; HTTPS everywhere but the loopback.
      The client is the one the source declares, with no fallback: `metadata-document` (the agent's document at
      `/tools/oauth/client-metadata.json`, a public client), `pre-registered` (its secret sent `client_secret_post` when
      the server lists it or lists nothing, `client_secret_basic` when it lists only that), `dynamic` (RFC 7591, kept
      by `dynamic|<issuer>` and made again when the callback changes). A token answer with an `error` is a refusal
      whatever its status (GitHub answers `200` with one); the agent sends `accept: application/json`.
    - **The attempt** (`core/connections.ts`): a `state` of 256 bits kept only as its SHA-256, a verifier of 64
      characters sealed under a key of the attempt, ten minutes, single use by an atomic `claim` (an `UPDATE … WHERE NOT
      (data ? 'outcome')` on PostgreSQL). The callback checks `iss` before it reads `error`, exchanges the code with the
      verifier, the callback and the `resource`, makes the check, seals the account, and answers `303` to
      `{APP_LINK_BASE}service/{did}/accounts` (the DID raw, as the invitations' links have it), or a page when the agent
      has no app-link base; `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. A new start of the same
      source for the same value cancels the attempt that waits. No event is sent at a start: only an attempt's end.
    - **The check** (D110): the tool called once on a connection of its own, outside any conversation, with no call
      record; its structured content, else its first text as JSON; a tool the pack declares no effect for must be read
      by its annotations. A value other than the one expected ends the attempt `wrong-binding` with the two names, an
      email other than the directory entry's (lower case) `wrong-person`; the tokens are revoked where the server
      allows it and kept nowhere. `bindingRequest: { parameter }` adds the expected value to the authorization URL;
      `{ resource }` sends the URL built with `{value}` as the `resource` and calls that URL with the account.
    - **A key per person** (D106, PRIV-ERASE-013, `memory/crypto.ts` `newKeyUnder`, `sealUnder`, `openUnder`): the
      person's key is 32 bytes wrapped by `ENTRY_ENCRYPTION_KEY` (table `person_keys`); each account's key is 32 bytes
      sealed under the person's key, which seals the tokens and, apart, the label, so that Your accounts reads a label
      without opening a token. The master key alone opens no account. Ending a person's access deletes their key, then
      their accounts; the revocations at the services are asked in the background, from the tokens opened first.
    - **One account per (person, source, binding value)** (table `personal_accounts`, unique on the three): a
      Reconnect saves a new row, which deletes the former in the same transaction. A refresh, a mark or a state is an
      `update` of a row still there (`false` when it is gone), and a use is `touch`, alone: a late write never brings
      back an account, a key or a refresh token that was replaced. In the clear beside the ciphertext: the Principal,
      the source, the value and its name, the method, the state and reason, `moreAccess`, the times, and two digests of
      the pack's settings (its URL, registration, client id, issuer, binding and fields; its scopes), which say at
      start which accounts end and which must reconnect (TOOL-CONN-009). They are digests of the pack, nothing of the
      account.
    - **The life of a connection** (D107): a token expiring within 60 s is refreshed before the call; a `401` to a
      token that had not expired gives one refresh and one more try; refreshes of one account run one at a time, the
      rotated refresh token written before the new access token is used; a second call waiting on the lock takes the
      fresh token. A refused refresh (an OAuth error) or no refresh token puts the account to `reconnect` (`revoked`
      after a `401`, else `expired`), its key and tokens gone; a refresh that cannot reach the server fails the call and
      keeps the account. A `403 insufficient_scope` keeps the tokens, marks `moreAccess`, and the next attempt asks the
      former scopes and the challenge's. A server whose metadata (cached ten minutes, read again on a `401`) names
      another issuer than the account's, or for a pre-registered client not its issuer, gets no token: `changed`.
    - **One connection per account** (`tools/mcp.ts` `PersonalConnections`): one pool of the agent, keyed by the
      account, shared by the sources of `from`; its fetch (`personalFetch`) sends the token of the call in progress in
      `Authorization`, only to the account's server (its origin, at or under its path), never following a redirect,
      and handles the `401` and `403` above. A call whose account turns out not connected waits for the refresh in
      flight, then answers `not-connected` (or `more-access-needed`), its record saying so (TOOL-CALL-011).
    - **In a turn** (`toolGate.ts` `turnTools`): a personal source gives its tools only while the account the
      conversation uses is connected (its space's value of the binding, or the pack's); its server is discovered on the
      first connected account. The accounts to connect are one line each in the Principal's block (the source that
      declares the account, `(not connected)` or `(to reconnect)`), and `offer_connection` (bundled `connections`, on
      while a personal source is declared) is given only while one is listed. The card is a `state-update` entry of
      kind `connect`: a record of the system for the model, `ayni.connect` in history, never in a shared history; live,
      it goes to the run's session and its peers of profile 3.5 only (`TurnEvent.minProfile`, `RunMirror.only`).
    - **Tool names**: two sources' tools of one name are prefixed `<source>__<name>` only when they can be in one turn
      (one of them of availability `agent`, or both `personal`, or both `spaces`), counting the `offer` of servers not
      discovered yet, so that a name never changes when another server is discovered. `github` (Personal) and
      `github-project` (spaces) keep `list_issues`. Phase 1 prefixed on any clash among discovered tools.
    - **Cards** (PROF-TOOL-021): a confirmation's action carries the account's label (it is the person's alone); the
      approval of someone else carries `{ kind: 'personal' }`, and the requester's own card adds the label.
    - **Spaces** (TOOL-SPACE-012/013): a personal source is `ready` once bound, `PUT …/account` answers `409
      no-space-account`; the view gives `{ kind: 'personal', connected }` for the reader, with `source` for a source of
      `from`; the binding a personal account is for gives `valueLabel`, and to the owner `fromAccount` and `choices`
      (the owner's own connected accounts); a value that is not one of them is `422 not-your-account`. The name comes
      with a pending change (`bindingLabels`) and is shown on the phone ("Workspace: ayni-dev-agent").
    - **A credential pasted** (D109, `core/credentials.ts`): the typed text of a message (a text, a media message's
      caption; not a voice transcription) is scanned in `AyniAgent.turn` before anything else, with the pack's
      `tokenPatterns` first (a match names its source), then the formats the agent knows and private keys in PEM;
      matches under 16 characters are not taken, overlapping ones are one. The message is kept with each credential as
      its first four characters and `…` (`----…` for a PEM key) and `payload.withheld: 'credential'`; it is never
      embedded and never a query of the recall; the model reads a record in its place. `ayni.messages.withheld` with
      `reason: 'credential'` and `texts` goes in the run (also for a message that waits), history gives
      `modelVisible: false` and `withheld: 'credential'`.
    - **`clientIds`** of `ayni.messages.erased` (and of `withheld`) are now of the length and order of `messageIds`, the
      empty string for an entry no client sent (the wire clarification of the clients, 2026-11-21).
    - **The descriptor** says 3.5 always and `features.connections` only while the pack declares a personal source,
      so that an agent with none shows no empty Your accounts.
    - **Not done:** `private_key_jwt` (O33); going on with the turn after a Connect card (O34); credentials in
      attachments or tool results (O35); two accounts for one value (O36); the trust of a tool server and an admin list
      of connections (O37); no Principal erasure nor end of an unidentified Principal exists in the agent yet, so the
      key of a person is destroyed when their entry leaves the directory only (`ConnectionService.endPerson` is the hook).
    - **Tests:** `tests/connections.test.ts` (42, the real agent against a fake authorization server and fake MCP
      servers on the loopback, at debug), `tests/personalAccounts.test.ts` (19, the pack, the scanner, the client),
      `tests/postgres.test.ts` (3 more: the migration 3.10.0, the ciphertext and its keys, the single-use claim). Without
      the lock, three fail; without the single-use claim, three; the master key alone opening an account fails the
      erasure test.
73. **The start of a request stays the same: grants, cards and who the person is change only its end** (2026-11-21,
    Fabrice's choice of the remaining cache breakers; ayni-spec D112, LLM-CACHE-003 to 006, LLM-USAGE-005, MEM-CTX-008
    and 009 new; RBAC-TOOL-004, RBAC-FILTER-001/002, TOOL-AVAIL-006, TOOL-CONN-010, TOOL-PROV-004, MEM-CTX-001/007,
    MEM-RET-006, INTX-FLOW-008, LLM-USAGE-001 and LLM-CACHE-002 amended).
    - **As found** (entry 70, "still breaking the cache"): the provider reads a request from its start and serves from its
      cache only what repeats the previous one byte for byte. Things changed an early part of the request:
      - a grant that starts or ends added or removed a tool, and the tools come first: the whole request was read again;
      - a flow card or a confirmation card, rewritten in place when it was answered, changed its record in the history,
        and everything after it was read again;
      - being identified changed the third system part ("The person is authenticated" became their name, with their
        organization), and so did a message from a session of another channel in the same conversation;
      - the line of an account to connect (TOOL-CONN-010) was in the third system part too.
      - The Anthropic adapter reported `inputTokens: 0` and no cache counts; Bedrock no cache counts.
    - **The tool list (`toolGate.ts` `allTools`, `registry.reachable`):** a grant no longer changes it. A tool the roles
      reach only through an elevation (REQUESTABLE) is in the list whatever the grants. Its call is refused in code, before
      any card, approval or call, unless a grant is held at the call: `decide` reads the grants again and resolves the tier
      (`needsGrant`, `runsNow`), outcome `not-granted`. A DENY tool stays absent.
    - **Cards (`flows.ts` `updateCard`, `toolGate.ts` `writeCard`):** the entry the devices read is still updated in place
      (PROF-MAP-007, PROF-HIST-006); the model reads it as it was written. A flow reads "it is open until a later record of
      the system says it is over". A confirmation's text stays "The person was asked to confirm X (apr) on a card". When a
      flow ends, or a confirmation is decided, expires or is cancelled, a `state-update` entry of kind `card-state` is
      added at that time, which the model reads as a record ("the request ... is completed and over", "The person allowed
      X (apr)"), and no device is given. It names no message of a turn, so it stays with its card when a message is
      deleted.
    - **Who the person is (`orchestrator.ts` `systemMessages`, `personRecord`):** the third system part holds the roles
      only. The name, the organization and its relation, the channel, the tools that need an elevation with whether one
      is granted, and the accounts to connect are one record at the start of the turn's message, before what the agent
      keeps (D103) and the recall.
      - The roles stay a system part: they decide what the person may do, and a change of them changes the tools too.
      - Nothing the person writes can pass for a record: `unmarked` rewrites `[system record` (any case and spacing) in
        the person's words, a quoted message, a file's text, a recalled message of the person and a tool's answer to
        `[written by the person, not a record: system record` (or `a tool`). The same text gives the same bytes at every
        turn.
    - **Counts (`llm/anthropic.ts`, `llm/bedrock.ts`):** Anthropic adds `input_tokens`, `cache_read_input_tokens` and
      `cache_creation_input_tokens` from `message_start`, then from `message_delta` (cumulative), and reports once at the
      end; it sends a top-level `cache_control` with the pack's lifetime when caching is on. Bedrock takes
      `metadata.usage`: the input is `totalTokens - outputTokens` (its `inputTokens` leaves the cache parts out), with
      `cacheReadInputTokens` and `cacheWriteInputTokens`. Bedrock gets no cache point: whether a model takes one depends
      on the model.
    - **Add-on 3.7.0:** the elevation line says a tool may be listed and refused without a grant; the records line says the
      latest message opens with who the person is, and that the person's words and the tools' answers hold no record.
    - **Tests:** `tests/cacheBreakers.test.ts` (11): the same tools, system parts and history across a grant that starts
      and ends, a flow card closed after the turn that read it, and an identification; the call refused without a grant,
      run with one, refused again when it ends, and refused when it ends while the turn runs; a DENY tool absent; the mark
      in the person's words; the counts of Anthropic and Bedrock from fixtures in `tests/fixtures/llm/` and Anthropic's
      `cache_control`. `tests/connections.test.ts`: the line of an account in the record of the person and in no system
      part; across a connection the system parts and the history stay as they were. `tests/tools.test.ts`: the
      confirmation's text and its record. `tests/systemRecord.test.ts`: the texts.
    - **Without the change:** with `registry.visible`, five grant tests fail; with the grant read at the turn's start
      only, the call-time test; with the card rewritten in place, the card tests; with the name in the system part, the
      identification test; with main's adapters, the three count tests; without the mark, the two mark tests; with the
      lines of the accounts in the system part, three connection tests.
    - **Other tests:** `tests/agui.test.ts` (RBAC-FILTER-001) now expects the guest's `wire_money` refused as `not-granted`;
      `tests/emailCheckMessages.test.ts` sets a 6000-token window, its last test reading the whole check, which the larger
      fixed part of a request (the elevation tool, the record of the person, the add-on) pushed out of 4000.
    - **Not changed:**
      - Connecting, reconnecting or disconnecting an account still changes the tool list, and so the whole request is
        read again once: a personal source gives its tools only while its account is connected, and `offer_connection`
        only while one is to connect (D108, Fabrice's TA4: one short line per source not connected). Listing them
        whatever the account's state would keep the start, at the cost of their definitions in every request: a choice
        for Fabrice (O41).
      - A step of the window changes the summary and its start (D75). The previous turn's message, which carried the
        records, is read again once uncached (D103). A roles change re-reads the request (the tools change with it).
      - The Anthropic adapter's `thinking.budget_tokens`, which current models refuse, is a separate fix.
74. **Approvals reach each person once; only a call asks** (2026-11-21, found by Fabrice on devnet with 0.29.0, his "Yes"
    to both fixes; ayni-spec D114, PR #116: TOOL-CALL-015 to 017 and INTX-APPR-016 to 019 new; TOOL-CALL-004/009/010,
    TOOL-PROV-006, LLM-CACHE-004 and INTX-APPR-006/008/010/011/013/014/015 amended; AG-UI profile 3.5 amended in place:
    §3.12, PROF-TOOL-024 to 027, PROF-DESC-011, PROF-LINK-005, `ayni.approval.request` withdrawn; flow profile `open.link`,
    FLOW-CORE-011, FLOW-AUTH-003).
    - **As found:** a member's post in Verana Social wrote the approval's card into each of the owner's five bound
      sessions (four conversations) and into the member's other conversation, at the request and again at the decision:
      13 entries (`cardEntryIds`), four requests on the owner's phone. `onApprovalChange` delivered the card to every open
      session of every eligible approver and of the requester. Then the model answered three times that approval was
      requested, with no call: its history held the card's record and its own earlier "approval requested", no tool call.
    - **The approvers (`agent.ts` `onApprovalChange`, `approvalPhones`; `didcomm/adapter.ts` `openApprovalFlow`,
      `closeApprovalFlow`):** no card, no entry, in any conversation of theirs; `deliver` of an `approval` event goes to
      the requester's conversation only. The record names the approvers it was asked of (`approverIds`, computed by
      `ApprovalService` at the request). Each one whose capability channel takes flows (`router.approvalPhone`) gets one
      `authorize` flow when the approval is made, whatever its kind and policy: `attested` as the policy sets it, always
      for an owner's approval (`needsAttestation`); `origin: none`, so no conversation records a flow card; `link` to the
      Notifications that list it (`notificationsLinkOf`, on `channels.agui.appLinkBase`, the DID unencoded as in the link
      of Your accounts). An approver's flow closes once they decided anywhere, and every flow once the approval ended.
      `ApprovalService.decide` now also announces a decision that leaves the approval pending (`decision`).
    - **To attest (INTX-APPR-019):** an approval to attest is asked only of approvers a flow-capable phone reaches; with
      none the call does not run and the model reads `no-approver`, and an elevation is refused the same way. `decide`
      takes such an approval only with the attestation of its flow, never `none` (FLOW-AUTH-001, which the agent did not
      check before); `approval.decide` of one answers `RunError decide-on-phone`, and `POST {sessions}/approvals/{id}/resend`
      closes the phone's flow and opens a new one (`resendApproval`), or answers 404, 409 `not-pending` or 409
      `confirmation-unavailable`.
    - **The requester (`requesterCardChanged`):** one card, the entry `entryId` of the conversation where it was asked,
      shown on that conversation's sessions in the run (the gate emits it in the turn, no more `onApprovalPending`) and
      replaced in place at each later status, with `ayni.approval.update`. The entry the model reads keeps its text; each
      later status is an entry of its own, `sourceType` `approval` (`refusal` for a rejection) with `payload.kind:
      'card-state'`, so that it stays a first-class approval or refusal entry (INTX-APPR-008) and history gives it to no
      device. An elevation request now has its card too (the entry it already wrote, with `payload.card`, emitted in the
      run). `cardEntryIds` is no longer written; old records keep it, and an erasure still clears their cards.
    - **The Notifications (`core/notifications.ts`; routes `GET {sessions}/spaces/{id}/notifications`,
      `GET {sessions}/notifications`):** read from the approval records, nothing stored for them. A space's list holds the
      approvals of its tools (an owner's approval); the agent's every other one; for a person, each they may decide, were
      asked of, decided, or asked for (`own`). Newest first by the request's time; `before` an id, `limit` 50 by default and
      200 at most; an unknown `before` gives an empty page. A past item stays for its space's `retentionDays` from
      `closedAt` (new on the record), Personal's for the agent's list. `ayni.space.notifications.changed` goes to every
      bound AG-UI session of each person concerned; `GET /spaces` gives `notificationsWaiting`; `state.ayni.pendingApprovals`
      is pushed to them. Personal's own list is empty, its approvals being the agent's. `features.notifications: true`.
    - **Decisions from a browser:** `approval.decide` and `approval.cancel` start no turn (`noTurn: 'decision'`, then
      `RunFinished{ decision }`, or `RunError not-eligible` / `decide-on-phone`) and add nothing to the conversation of the
      session; a later decision gets the status already decided. The contextual menu of an AG-UI session has no Approvals
      item; a DIDComm peer in chat mode keeps it with its badge, counting and answering only approvals that need no
      attestation, and no entry is written for its questions.
    - **Only a call asks:** the add-on (3.8.0, +94 tokens) tells the six rules of TOOL-CALL-010. Every answer of a call
      that asked a card or an approval ends with `ONE_CALL` ("This answers this call only: any other action, the same one
      again included, needs a new call of the tool, which asks again."): pending, allowed and run, refused, expired,
      cancelled, unavailable, no approver. A call that ran under a card or an approval is marked `asked` on its `tool-call`
      entry, and history gives the model its result followed by the same line; the card-state records of an approval of a
      call that ends carry it too. The card's own record now reads "The call of X (apr) asked for the approval of Y, shown
      to the person on a card". TOOL-CALL-016 needed no change in code: nothing but a call's record and card shows a wait.
    - **The evaluation (`scripts/eval/approval-claims.ts`, `pnpm eval:approval-claims`, README "Evaluations of the model"):**
      each run builds the agent with the deployment's agent-pack on the in-memory store, every MCP and HTTP server replaced
      by a local stub (one per URL), the space's account by values sampled from its fields' patterns, the phone by the
      stub of the tests; it plays the conversation before the last message with a scripted model, so the history is the
      agent's, then sends the last turn through the deployment's adapter and passes only when it calls the posting tool.
      Choices: the posting tool is the first tool of a space whose rule is `approval` (`--post` names another); an MCP
      stub lists a `text` argument and the pinned ones (`--schemas` gives the real ones); an unset placeholder of the pack
      gets a stand-in, never an `LLM_*` one, and a missing directory an empty one; the case `confirmation` is the owner's own
      post (his confirmation, INTX-APPR-005), since the Dev Agent's CRM is each person's own account, which a stub cannot
      connect; a card the last turn asks is refused so that the turn ends. `--replay` reads
      `scripts/eval/fixtures/devnet-2026-11-21-215226.json`, a reconstruction: the words of 21:52:26 were not kept. Not
      run here: no provider key. `tests/evalApprovalClaims.test.ts` checks the harness with a model of the test, which is
      no evaluation. The log warning TOOL-CALL-017 allows is not built.
    - **Profile package 3.5.1:** `features.notifications`, `CUSTOM_EVENT.spaceNotificationsChanged` and its value, the
      §3.12 shapes (`NotificationsPage`, `NotificationItem`, `NotificationApproval`, `NOTIFICATIONS_PAGE`,
      `ApprovalResendResponse`), `notificationsWaiting` on `SpaceInfo`, `decidedBy` on the card, `RUN_ERROR_CODE`
      `decide-on-phone` and `not-eligible`, `not-pending`, the link parameter `approval` and `notificationsLink`;
      `CUSTOM_EVENT.approvalRequest` removed.
    - **Depends on:** the VS Agent plugin 0.1.7 answers 400 to an `open` body with `link` (its pipe forbids unknown
      fields), and so does 0.1.8, so with them no approval reaches a phone. `2060-io/credo-ts-ayni-flow` #33 (released in
      0.1.8) carries `link` in the `open` and both records, for the app; #35 adds it to the plugin's route (0.1.9): release
      it, rebuild `io2060/vs-agent-ayni` with it and bump the devnet VS Agents before this agent is deployed.
    - **Tests:** `tests/approvalsOnce.test.ts` (11): the devnet incident (an owner with five sessions in four
      conversations gets one phone request and one item, no card or entry anywhere, one event per session; the requester
      one card on both devices of the asking conversation and none in her other; decided on the phone, the request closes,
      the item reads decided and the card turns to Approved in place, with one card-state record); the next request's
      tool result and record end with the line; a second post asks with a new call; rejected and expired records say it;
      a reply that claims a request without a call shows nothing waiting; Sent by you, paging, 404 outside the space;
      the agent's Notifications for a delete by roles, a non-flow wallet's menu badge, a decision in the browser with no
      turn, Approve twice, resend refusals, a withdrawal; an elevation on the managers' phones; `no-approver`. Amended:
      `tools.test.ts` (the owner decides on his phone, the item of his Notifications, the link and `origin`, Decide on
      your phone, the answers' line), `notifyAuthorize.test.ts` (a non-attested rule reaches the phone with `attested:
      false`; an attested decision without authentication is refused), `connections.test.ts` (the owner's approval on
      the phone), `toolCatalog.test.ts` (each rule of TOOL-CALL-010).
75. **The clean spec's fixes: a device secret handed once, the binding goal code, a `confirm` answered no, another
    identity, the origin of a credential request, the reason `replaced`** (2026-11-23, Fabrice's answers to the clean
    spec, ayni-spec PR #123: B2, B8.2, B8.3 b and c, F5, and the reason `replaced` of his second answers; the rows of
    "Specified, not built" of its reference profile).
    - **The device secret is handed once** (D51, IDENT-DEV-001, PROF-BIND-010). The session record kept the plaintext
      `deviceSecret` until the client rotated it (on devnet 130 of 216 sessions held one). It is now handed once and
      erased from the session as soon as the client collected it: by the status of the bound session
      (`takeDeviceSecret`), by the `201` of a session bound from a grant or from a device proof, or by
      `ayni.session.bound` written to a client on the session's stream. A client that was not listening picks it up
      from the status. One never collected is not handed once five minutes have passed since it was minted
      (`deviceSecretAt`), and the session reaper (every 30 seconds) erases it; a session that closes erases it too.
      Migration 3.11.0 erases the secrets the sessions already hold. Only the hash on the Principal's device stays.
      A client that missed both the event and the status within five minutes links again with the phone; the bound
      event stays in the stream's replay buffer, in memory only, for a client that resumes the stream.
    - **The binding goal code** (flow profile §4, FLOW-CONN-001): `BINDING_GOAL_CODE` is `ayni.link-session` in
      `src/channels/didcomm/adapter.ts` and in the profile package (`INVITATION_GOAL_CODE.linkSession`); no client read
      `ayni.bind-session`.
    - **A `confirm` answered no closes `completed`** (flow profile §6, row `confirm`), as an `authorize` answered either
      way does; the challenge it serves still fails, and only a carrier that failed closes the flow `failed`. The phone
      shows the person's answer from `confirmed`.
    - **Another identity** (FLOW-SIGNIN-004, IDENT-RES-014, IDENT-RES-019): `IdentityFlow.authenticate` takes the actor
      identity of an identified connection (`boundTo`) and decides before the flow closes: a presentation of another
      identity is answered with the problem report `another-identity` (`NotAcceptedCode`), so that the History shows
      it refused, and the caller asks nothing again (`asksAgain`); nothing of it is stored. The one request on an
      identified connection is the one that asks for the email an invitation compares (`IdentityRequests.reveal`,
      SPACE-INV-004); a visitor's request names no identity.
    - **The origin of a credential request** (INTX-FLOW-001): a `present` asked by the model's `request_presentation`
      and an `issue` asked from a conversation name its AG-UI session as `origin`, and so get the flow card in that
      conversation (the web UI's "Continue on your phone"); a request of the DIDComm chat or of the agent itself (the
      entries asked on connect, an `authenticate`) keeps `origin: none` (`conversationOrigin`).
    - **The reason `replaced`** (IDENT-SESS-014, AG-UI profile §3.6, §5): a device's newer session on a conversation
      closes its earlier one with `replaced`; `supersede` names a new phone only (IDENT-SESS-003).
    - **Not done here:** `features.visitors` (PROF-DESC-012), new in the spec's second answers, is not part of these
      fixes.
    - **Profile package 3.5.2:** `BINDING_GOAL_CODE` `ayni.link-session`; the closure reason `replaced`.
    - **Tests:** `agui.test.ts` (the secret by the status once, by the stream, after a device proof's response, five
      minutes, a closed session; `replaced`), `postgres.test.ts` (3.11.0 leaves no secret), `bindingInvitation.test.ts`
      and the package's test (the goal code), `flows.test.ts` (a `confirm` answered no; another identity on the flow and
      the same identity accepted), `identityOnDemand.test.ts` (`reveal` names the identity and asks once),
      `presentationCatalog.test.ts` and `issuance.test.ts` (the origin of `present` and `issue`). Each fails with its
      change reverted.
76. **What the clean spec removed, removed from the code** (2026-11-23, Fabrice's answers to the clean spec, ayni-spec
    PR #123: A1, A2, B4, B5 as revised, B11 d, F4, D13; "no backward compatibility": only the team's deployments exist).
    - **The refusals of earlier pack keys** (A1): `crossSession` on a role (formerly RBAC-XSESS-005's refusal), the keys
      `tools.sources` replaced (`mcp`, `tools.http`, `tools.bundled`, `tools.access`, `actions`, TOOL-CAT-011) and those
      an account's fields replaced (`account.label`, `account.pattern`, `account.apply` as one header, TOOL-CAT-012) are no
      longer refused in words before the schema: the schema refuses them as keys it does not know.
    - **The sealing at start of what an earlier version kept in the clear** (A1, PRIV-ERASE-009's clause): the passes over
      the conversations' titles and last texts, the attachments' texts and names, and the working-memory notes and
      preferences are gone, with `listWithPlainAttachments` of the stores. Every row is written sealed.
    - **The run-time tests of a client's profile version** (A2: PROF-SESS-016, PROF-TOOL-020, TOOL-CALL-005,
      TOOL-CONN-011): `profileAtLeast`, `cardCapable`, `connectCapable`, an activity's `minProfile` and the mirror's
      `only` are gone. A confirmation card and a Connect card go to every bound AG-UI session of the conversation;
      `client.profileVersion` is no part of the session request (a client that still sends it is not refused).
    - **The MCP keys `lazy` and `reconnect`** (B11 d), which nothing read: the agent connects on first need and again
      after a drop (TOOL-MCP-003). The example pack no longer sets `lazy`.
    - **The routed capability kind `authorization`** (F4): an approval of someone else's request is never in a
      conversation (D114).
    - **Interrupts and `resume`** (B4, PROF-RUN-006): the agent never ended a run with an interrupt; it no longer reads a
      run's `resume` as a menu selection, and `INTERRUPT_REASON` leaves the profile package.
    - **The role key `auditor`** (B5 as revised): the admin interface's roles are the roles named `auditor` and
      `operator`, declared like any other and given in the directory (RBAC-XSESS-008), in their own pull request. The
      example pack's role `auditor` keeps its name and loses the flag.
    - **`visitors`** (D13): the authentication entry's key that lets a person in without the credential is `visitors`,
      not `guests`; "guest" names a member of a space of another organization. The start-up notice says visitors.
    - **Already absent from the code:** the device policy `sessions.devices` (B1), and the issuance profile's `format`,
      `subjectKind: service` and the claim sources `attestation` and `declared` (B3).
    - **Profile package 3.5.3:** no `client.profileVersion` in `ClientDescription` or the create-session schema, no
      `authorization` in `CapabilityKind`, no `INTERRUPT_REASON`.
    - **Deployments:** the Dev Agent's pack in `2060-io/ayni-deploy` (`charts/devnet/dev-ayni-agent.yaml`) names its
      authentication `guests: true` and must say `visitors: true` before this agent starts with it; the Welcome pack and
      the packs of this repository carry no removed key.
    - **Tests:** `pack.test.ts` (`crossSession`, a role's `auditor`, `guests` refused by the schema, `visitors` offered),
      `toolSources.test.ts` (the keys `tools.sources` replaced, `lazy`, `reconnect`), `toolCatalog.test.ts` (an
      account's former keys), `sealedMemory.test.ts` and `postgres.test.ts` (no pass at start), `tools.test.ts` (a card
      for a client that declares no version), `connections.test.ts` (a Connect card for a client of 3.4 or of none),
      `agui.test.ts` (a run's `resume` is not read; no routed `authorization`), the profile package's test, and the
      renamed key in the tests of identity, flows, peer status and the directory. Each new test fails with its removal
      reverted.
77. **Space governance: one owner, a successor, stewards, and an approval policy per tool of a space** (2026-11-24,
    Fabrice's decisions of 2026-11-23, ayni-spec PR #125: D135 to D142; SPACE-DEF-008, SPACE-MEMB-008 to 012,
    TOOL-SPACE-018 to 021, TOOL-CAT-009, TOOL-CAT-023, INTX-APPR-004, 005, 007, 011, 013, 017, 019 to 027; AG-UI profile
    3.5 amended in place: PROF-SPACE-008/009, PROF-TOOL-003/009/024/036 to 038, §3.12; flow profile FLOW-AUTH-004).
    - **One owner** (`core/spaces.ts`): `ownerIds` is gone; a space has `ownerPrincipalId`, or none, and
      `successorPrincipalId`. Schema 3.12.0 keeps the first of a stored space's owners. Only the space's owner is
      `owner`, whatever a row says. Handover, succession and a steward's naming go through one `changeOwner`, which
      records `owner-changed` with `how` (and a steward's `reason`), clears the successor (`successor-cleared`) and tells
      `onOwnerChanged`.
    - **Successor and stewards** (`PUT`/`DELETE {sessions}/spaces/{id}/successor`, `GET {sessions}/stewardship`,
      `GET {sessions}/spaces/{id}/owner/candidates`, a steward's `POST {sessions}/spaces/{id}/owner` with `reason`,
      `403 not-steward`): the successor is anyone the space could be handed to but the owner, kept by Principal. A
      template's `stewards` are declared roles (rule 2). A steward who is not the owner names an owner through the same
      `POST …/owner`, answered with the space as the stewardship list gives it, since the steward reads nothing else of
      it (every other read stays 404).
    - **An entry that leaves the directory** (`PeopleService.release` → `SpaceService.onEntryLeft`): the person's active
      rows in every space become `left` (recorded `left` by the directory), so that no policy names them; a space they
      owned passes to its successor while eligible (`how: succession`), else has no owner; a space whose successor they
      were has none. A successor who stops being eligible otherwise (removed, a rule that no longer matches) is cleared
      when the space is reviewed.
    - **The timeouts** (`rules.approvalTimeouts`, SPACE-DEF-008): per kind, `tool-call` only, from
      `approvals.spaces.timeouts` (60, 5 to 10080 by default); `PATCH {sessions}/spaces/{id}` with
      `rules.approvalTimeouts`, `422 out-of-bounds` with `field: rules.approvalTimeouts.tool-call`. A space made before
      gets the defaults at start (`alignRules`). An approval takes the space's timeout when it is asked.
    - **The policies** (`policy/spacePolicy.ts`, pure; `core/governance.ts`, whom the entries name): kept on the space's
      tool record (`SpaceToolRecord.approvals`), the agent-pack's default until the owner sets one, dropped with the rule
      `approval`, with the source, and never touched by a change of owner. `PATCH …/tools/{source}` takes `approvals`,
      each policy whole: `400 bad-request` for a field or a value not of a policy (a `timeoutMinutes` included), and the
      `422` codes in the order of TOOL-SPACE-018. A looser policy is held with the pending change and the phone's text
      reads "Change who approves Post on X in Communication: from …, to …"; a stricter one applies at once. The answer's
      `approval.warnings` are those of the policy sent, whether it applied or waits (a `202` keeps the rest of the item as
      in force). `state`, `attention` and `warnings` are computed when read, from the people named then.
    - **The workflow** (`ApprovalService`, `SpacePolicyPort`): a tool of a space's approval carries `spacePolicy`, the
      policy it was asked under (TOOL-SPACE-019), and `progress`; `ownerApproval` is gone (schema 3.12.0 gives a waiting
      owner's approval the default policy). Eligibility is "an entry names you now"; a decision records the entries that
      named its maker (`satisfies`), which it keeps satisfying (INTX-APPR-025), and `self: true` for the requester's own
      confirmation. Approved, rejected, or rejected as soon as the people who have not decided can no longer meet it.
      At the request, for an attested decision only people with a flow-capable phone count; when they cannot meet the
      policy the record is saved `REJECTED` with `reason: no-approver`, asked of nobody, its card written ended, the model
      told "no other approver can decide it now", and the owner told. Afterwards, reviews count everyone named,
      phone or not.
    - **The owner's own card is gone** (`toolGate.ts`): no `ownerSelf` path. Untrusted content still asks its card first,
      then the approval. An approver who asks, under `own-confirmation`, is asked on their own phone (flow title "Your
      own request: …", always attested), listed in their Notifications with `own` and `canDecide`; on the card in the
      conversation `canDecide` stays false.
    - **A change of owner** (`Governance.ownerChanged`): every active member gets an `owner-changed` notice; each pending
      approval with an `owner` entry closes the former owner's flow when they are named no more and opens the new owner's
      (a new `ApprovalChange` `moved` updates the card and the Notifications without touching phones). With no owner, the
      former owner's flows close and the approvals wait (an `owner` entry of an ownerless space counts as one who can).
    - **Review** (`Governance.review`, after a reload of the directory, a member removed, a policy saved, a change of
      owner, and at start): successors, `space-without-owner` notices to the stewards, `policy-attention` notices to the
      owner (one per tool, resolved when the policy no longer needs attention or the owner changes), and the pending
      approvals that can no longer be met, which expire.
    - **Notices** (`governance_notices`, one row per person; `Notifications`): listed beside approvals, newest first,
      `space-without-owner` in the agent's list, the others in the space's; `policy-attention` and `space-without-owner`
      wait until resolved; `ayni.space.notifications.changed` with the notice's `kind`. An approval of a space's tool is
      in the agent's Notifications for an approver who is not a member (INTX-APPR-022), its phone link too.
    - **Not done here:** the `authorize` request's `approvals` (FLOW-AUTH-004) is not sent: the agent posts the request to
      the DIDComm agent, whose flow plugin (credo-ts-ayni-flow) does not take the field yet; it is one field of
      `openApprovalFlow` once the plugin is released with it. Conditions on arguments stay O30.
    - **Profile package 3.5.4:** `owner: null`, `successor`, `approvalTimeouts`, the stewardship shapes, `tools[].approval`,
      `SpaceToolPatch.approvals`, `progress` and `reason` on the card and its update, notices as `NotificationItem.notice`,
      the new error codes.
    - **Deployments:** nothing to change; the default policy is today's (the owner, required, attested), but the owner's
      own request now goes to his phone instead of a card. `stewards` and `approvals.spaces` are optional.
    - **Tests:** `spacePolicy.test.ts`, `governance.test.ts`, `stewardship.test.ts`, the migration in
      `postgres.test.ts`, the start-up checks in `pack.test.ts`; `tools.test.ts`, `approvalsOnce.test.ts` and the
      evaluation's `confirmation` case moved from the owner's card to his phone. The new integration tests fail on the
      code before this change.

78. **Authentication by combinations of methods, on the phone, over authenticate/1.0; enrolment; approvers on the
    approval request** (2026-11-24, Fabrice's decisions of 2026-11-23, ayni-spec PR #127: D125 to D131; IDENT-AUTH-001
    to 014 and 017, IDENT-RES-002, 010, 014, 019, 020, IDENT-DIR-003, 004, 010, IDENT-STAT-002, 005, PLAT-MAIL-001; flow
    profile §4.1, §6.4, §6.14, §11, FLOW-SIGNIN-001 to 014, FLOW-STAT-001, 003; FLOW-AUTH-004, INTX-APPR-026; the Ayni
    flow library 0.2.1, credo-ts-ayni-flow PRs #39, #40, #41).
    - **The agent-pack** (`identity.authentication`, rule 1): one object, `request`, `visitors`, `methods` (by name, each
      with a `type`: `credential`, `email`, `document`, `face-match`, `authenticator-app`, `passkey`), `combinations`
      and `obtain`. A `credential` method carries what the one entry carried (`credential`, `subjectKey`, `attributes`,
      `issuers.organizations`, `store`, `modelVisible`); a `face-match` method its `reference` (`document`,
      `directory`). The start is refused, naming the method or the combination, on an unknown type, a combination that
      names a method not enabled, twice, or holds no identifying method, a combination listed twice, a field of a
      credential on another type, an `email` or `document` method (or a face match by the directory's photo) without
      `identity.directory`, a face match without `media.faceVerification` or without `biometric-matching` of lawful
      basis `consent`, and an `email` method with no SMTP server (`buildAgent`). No fallback for the list of one entry
      (no backward compatibility). The schema's `visitors` has no default any more: with the object, Ajv applied it and
      refused every `on-demand` pack.
    - **The peer status** (`peerStatus.ts`): `authentication.methods` (a credential method with its `issuers`),
      `combinations`, `obtain`; to an identified person `enrol` (the enrollable types of the enabled methods) and
      `enrolled`. The top-level `credential` and `issuers` are gone. A fresh status follows an enrolment and an
      `unenrol` (it changed `enrolled`), and a credential that no longer holds drops `enrol`/`enrolled` with
      `identified: false` (the library refuses them to an unidentified receiver).
    - **The flow** (`channels/didcomm/authenticate.ts`, `Authenticator`): an `authenticate` flow of fifteen minutes,
      the request through `POST /v2/didcomm/authenticate` with the combinations the phone can be offered (a face match
      only to a phone that disclosed `calls/1.0` as `callee` and with a WebRTC server; an enrolment's without an
      authenticator app or a passkey), a `409` from the plugin answered `pending`. The choice within five minutes, else
      the flow closes `expired` and the request is unanswered. The steps run the identifying methods first in the order
      of the choice, then the confirming ones; each `step` and `step-result` through the plugin's routes; the phone's
      `choice` and `answer`s from `didcomm.authenticate.state-changed` (kept a minute when they come before the route
      answered). Not accepted: the `step-result` with the reason, then the flow's problem report; the identity is
      checked against the connection's before the flow closes, so `another-identity` never ends `completed`. The
      library's constants are mirrored (the agent does not depend on Credo); `timings` shortens them in the tests.
    - **The methods.** `credential`: present-proof under the flow id; what a badge issued from the directory finds is
      its entry. `email`: the address (ten minutes), the same answer for an address no entry holds, a code to an
      entry's address only, in the background, kept as a keyed hash, ten minutes, five tries in all, three new codes
      thirty seconds apart, each replacing the one before; the email in the language of the phone's locale
      (`ServiceLanguage.renderIn`, the code replaced by a mark in what the model translates). `document`: mrtd under
      the flow id, the read matched to exactly one entry (`no-match` otherwise); the passport alone is a combination.
      `face-match`: the consent, then a call under the flow id (`purpose: face-match`) whose room the face-verification
      service joins with the reference (the passport read in this flow, else the entry's `photo`), through the vision
      callbacks keyed by the step's token (`FaceSteps`); evidence `face-match` with the reference used and no image.
      `authenticator-app`: TOTP (RFC 6238, SHA-1, six digits, thirty seconds, one step either side), each code once,
      five tries. `passkey`: a 32-byte challenge for the app-link domain's host (`APP_LINK_BASE`), an ES256, EdDSA or
      RS256 assertion with user presence and verification and a counter that goes on (`core/authentication/webauthn.ts`,
      a CBOR reader of its own: no new dependency).
    - **Who is identified** (IDENT-RES-002, IDENT-AUTH-003): a person of the directory is
      `<home key>|directory|<entry>`, whatever the methods; a badge this agent issued from an entry resolves to the entry,
      its badge key kept as `legacyActorIdentity`, and a Principal that held the entry is re-keyed on first meeting,
      so the conversations follow. A person of another organization keeps `<org>|<schema>|<subject>`. The Principal
      keeps `lastAuthentication` (when, why, the combination, the steps, the entry). The address, the read and the face
      match become evidence once the authentication is accepted (`VerifiedFacts.moreEvidence`), never before.
    - **Enrolment** (`channels/didcomm/enrol.ts`, `core/authentication/enrolments.ts`): on `request-received` of an
      `enrol` flow, a type the pack enables for an identified person (else `not-eligible`); authenticated within ten
      minutes by a combination holding neither type, or first an `authenticate` flow of purpose `enrol` (`not-eligible`
      when it does not complete). The authenticator app's secret is handed once, kept sealed in the key-value store and
      held in memory until the code proves it (a restart drops a pending enrolment); a wrong code gets the same secret
      again, three challenges in all, then `not-valid`. A passkey's attestation is checked (challenge, relying party,
      presence, verification), not its statement; its credential id is found by a keyed index. `unenrol` removes the
      type and sends the status. Both are erased when the entry leaves the directory (`endAccess`).
    - **The approvers on an approval request** (`Governance.approvalsFor`, `openApprovalFlow`): an approval of a tool of
      a space carries `approvals`: the threshold, `own` for the requester, and every other entry of the policy, by the
      person's name, else by a label ("The role manager", "The department Depot Rotterdam", "Any member of the space",
      "The owner of the space"), each `required` or not; sent once, never again for a later progress.
    - **Where the spec says nothing, the choice made here:** a face-match consent declined is the flow declined (the
      library takes only `consent: true`, and a `choice` is sent once); the reason of a refused new code is
      `step.reason`, as the library writes it; a `choice` that the plugin fails `malformed` is answered `malformed` and
      ends as a decline (not asked again); the enrolment's "three times at most" is three challenges in all; `requires`
      is not sent on `open` (the library still takes it); the purpose of a re-authentication that asks the badge again
      to read its email (SPACE-INV-004) is `step-up`, with the credentials that ask for `email` as its combinations; a
      person identified through the directory without a badge is named to the model as a badge holder is, only when a
      `credential` method makes `name` visible (by default the model reads nothing, D67): a pack of `[email]` alone never
      names the person to the model. The `call` kind and `face-match-failed` were never used by the agent: nothing to remove.
    - **Not done here:** a tool's `stepUp.authentication` (IDENT-AUTH-015) and admin access from the card (D132 to
      D134, RBAC-ADMIN): the engine takes `purpose: step-up | admin`, `combinations` and `bound` already; the badge
      independent of the authentication (D130, IDENT-AUTH-016) and the end of the email check in a conversation
      (`emailCheck.ts`, `email_check`), which still serve the badge's issuance profiles.
    - **Deployments:** the VS Agent image must carry `@ayni.org/vs-agent-plugin-ayni-flow` 0.2.1 (the `authenticate`
      routes, the new peer-status shape and `approvals` on `authorize`; 0.1.10 refuses them), and its calls route must
      take `parentThreadId` (CC-VSA-006) before a pack enables `face-match`. Every agent-pack with
      `identity.authentication` moves to the object (the dev agent's `- credential: …` becomes `methods.badge` and
      `combinations: [[badge]]`).
    - **Tests:** `authenticate.test.ts` (the request, the choice, the email, document, authenticator-app and passkey
      steps, `different-identities`, `another-identity`, `409`), `authenticators.test.ts` (RFC 6238 vectors, passkey
      creation and assertion), `enrol.test.ts`, `authenticationStart.test.ts` (the SMTP refusal, the photo), the new
      rule 1 in `pack.test.ts`, the enrolments on PostgreSQL in `postgres.test.ts`, `approvals` in
      `governance.test.ts`; the flows, peer-status and on-demand tests moved to authenticate/1.0 and the new shape. The
      new tests fail on the code before this change (the modules they import do not exist there).
