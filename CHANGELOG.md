# Changelog

## [0.32.0](https://github.com/2060-io/ayni-agent/compare/v0.31.0...v0.32.0) (2026-11-24)


### Features

* **spaces:** one owner, a successor and stewards; an approval policy per tool of a space (ayni-spec D135 to D142) ([#122](https://github.com/2060-io/ayni-agent/issues/122)) ([0ff5026](https://github.com/2060-io/ayni-agent/commit/0ff502610472ebb5f828ac7a7af081d91406190f))

## [0.31.0](https://github.com/2060-io/ayni-agent/compare/v0.30.1...v0.31.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* an agent-pack whose authentication entry says guests must say visitors; an agent-pack that declares a role's auditor flag, an MCP server's lazy or reconnect, or crossSession is refused by the schema.

### Features

* what the clean spec removed: the refusals of earlier pack keys, the sealing at start, the client profile-version tests, lazy and reconnect, the routed authorization, resume, the role key auditor; visitors in place of guests (ayni-spec [#123](https://github.com/2060-io/ayni-agent/issues/123)) ([#119](https://github.com/2060-io/ayni-agent/issues/119)) ([55c06ae](https://github.com/2060-io/ayni-agent/commit/55c06ae5779dd71525bc564c7e164681e50795f4))


### Bug Fixes

* the device secret handed once, the binding goal code ayni.link-session, a confirm answered no completed, another-identity on the flow, the origin of present and issue, the reason replaced (ayni-spec [#123](https://github.com/2060-io/ayni-agent/issues/123)) ([#118](https://github.com/2060-io/ayni-agent/issues/118)) ([628711b](https://github.com/2060-io/ayni-agent/commit/628711bdf83e99ee9dda3300174660170a2a43ea))

## [0.30.1](https://github.com/2060-io/ayni-agent/compare/v0.30.0...v0.30.1) (2026-11-22)


### Bug Fixes

* **approvals:** Decide on your phone sends an approval again at most once every 30 seconds, one resend at a time (PROF-TOOL-026, INTX-APPR-019) ([#116](https://github.com/2060-io/ayni-agent/issues/116)) ([dabae1c](https://github.com/2060-io/ayni-agent/commit/dabae1c76434254ad9900c83ee4cd8779df88a2c))

## [0.30.0](https://github.com/2060-io/ayni-agent/compare/v0.29.1...v0.30.0) (2026-11-22)


### Features

* **approvals:** approvals reach each person once, and only a call asks (ayni-spec D114) ([#114](https://github.com/2060-io/ayni-agent/issues/114)) ([051d30d](https://github.com/2060-io/ayni-agent/commit/051d30d0efe412851d9c72296da9d97b3998c47e))

## [0.29.1](https://github.com/2060-io/ayni-agent/compare/v0.29.0...v0.29.1) (2026-11-21)


### Performance Improvements

* **prompt:** grants, cards and who the person is change only the end of the request; Anthropic and Bedrock report their cache counts ([#112](https://github.com/2060-io/ayni-agent/issues/112)) ([dd54dff](https://github.com/2060-io/ayni-agent/commit/dd54dffa2a93c86870b57debba504e5a90b18964))

## [0.29.0](https://github.com/2060-io/ayni-agent/compare/v0.28.3...v0.29.0) (2026-11-21)


### Features

* **tools:** each person's own accounts, OAuth as MCP defines it, a key per person (tools phase 2) ([#110](https://github.com/2060-io/ayni-agent/issues/110)) ([2c1473e](https://github.com/2060-io/ayni-agent/commit/2c1473e5713360df9776d18b6b1c8aff66cd7924))

## [0.28.3](https://github.com/2060-io/ayni-agent/compare/v0.28.2...v0.28.3) (2026-11-21)


### Bug Fixes

* **agui:** every answer of the profile carries Cache-Control: no-store (PROF-ERR-003) ([#108](https://github.com/2060-io/ayni-agent/issues/108)) ([50001c6](https://github.com/2060-io/ayni-agent/commit/50001c616a270776e9e7ef4fa44ae7fb650bd8f6))

## [0.28.2](https://github.com/2060-io/ayni-agent/compare/v0.28.1...v0.28.2) (2026-11-21)


### Performance Improvements

* **turn:** no model call to close a turn after memory saves, memories after the history, every model call timed ([#106](https://github.com/2060-io/ayni-agent/issues/106)) ([576560f](https://github.com/2060-io/ayni-agent/commit/576560f6b2dc5a1af905004634607f4f04569c20))

## [0.28.1](https://github.com/2060-io/ayni-agent/compare/v0.28.0...v0.28.1) (2026-11-21)


### Bug Fixes

* **binding:** a link over a new connection is asked as a reuse is, and every link-session request carries three codes ([#104](https://github.com/2060-io/ayni-agent/issues/104)) ([0da331d](https://github.com/2060-io/ayni-agent/commit/0da331dca946a695df09e32bdb16222615223877))

## [0.28.0](https://github.com/2060-io/ayni-agent/compare/v0.27.0...v0.28.0) (2026-11-21)


### Features

* **tools:** a space's account in named fields, one masked field per key, its headers built at the call (D102) ([#102](https://github.com/2060-io/ayni-agent/issues/102)) ([d2f2a99](https://github.com/2060-io/ayni-agent/commit/d2f2a99c837fb9cdb167d70234bb91d7e7378da8))

## [0.27.0](https://github.com/2060-io/ayni-agent/compare/v0.26.0...v0.27.0) (2026-11-20)


### Features

* **pack:** one map of tool sources, tools.sources, keyed by source id (D101) ([#100](https://github.com/2060-io/ayni-agent/issues/100)) ([9cb1264](https://github.com/2060-io/ayni-agent/commit/9cb12646c7230634aa2a2bab3412dff5b40b1521))

## [0.26.0](https://github.com/2060-io/ayni-agent/compare/v0.25.0...v0.26.0) (2026-11-20)


### Features

* **tools:** the tool catalog, tools in spaces, call rules and provenance (tools phase 1) ([#98](https://github.com/2060-io/ayni-agent/issues/98)) ([8da0038](https://github.com/2060-io/ayni-agent/commit/8da00384c25db8c23b597de2190225f3cce7d1a8))

## [0.25.0](https://github.com/2060-io/ayni-agent/compare/v0.24.0...v0.25.0) (2026-11-20)


### Features

* **email-check:** only an address or a code is taken; the model can resend or cancel; the check speaks the person's language; what the AI never read is marked ([#96](https://github.com/2060-io/ayni-agent/issues/96)) ([1c388d4](https://github.com/2060-io/ayni-agent/commit/1c388d42a1bbec0e96388562fc62e2c3e1d9bf1e))

## [0.24.0](https://github.com/2060-io/ayni-agent/compare/v0.23.1...v0.24.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* an agent-pack whose role declares crossSession no longer loads.

### Features

* spaces, personal memories per space, the employee list, badges from it, invitations; erasure within a window (ayni-spec [#94](https://github.com/2060-io/ayni-agent/issues/94)) ([#94](https://github.com/2060-io/ayni-agent/issues/94)) ([45874ef](https://github.com/2060-io/ayni-agent/commit/45874efc92b6a536d8777b670b186297b73d8f69))

## [0.23.1](https://github.com/2060-io/ayni-agent/compare/v0.23.0...v0.23.1) (2026-11-19)


### Bug Fixes

* **memory:** working-memory notes and preferences sealed (D77, PRIV-ERASE-009) ([#92](https://github.com/2060-io/ayni-agent/issues/92)) ([8caea23](https://github.com/2060-io/ayni-agent/commit/8caea2336a5019f600032fd8029901bfc51ed9b6))

## [0.23.0](https://github.com/2060-io/ayni-agent/compare/v0.22.0...v0.23.0) (2026-11-18)


### Features

* **context:** the context measured and shown, assembled for Kimi's cache and summarized in steps; memory scoped by conversation; erasure, audit and legal hold reachable ([#90](https://github.com/2060-io/ayni-agent/issues/90)) ([8d5a63d](https://github.com/2060-io/ayni-agent/commit/8d5a63db3b4e7b10e9edc5d9504eb5f1b7b7606d))

## [0.22.0](https://github.com/2060-io/ayni-agent/compare/v0.21.1...v0.22.0) (2026-11-18)


### Features

* **welcome:** a deployment sets the token budget of the context window (CONTEXT_WINDOW_TOKENS) ([#88](https://github.com/2060-io/ayni-agent/issues/88)) ([054011b](https://github.com/2060-io/ayni-agent/commit/054011b4daa07ca656589458a2f791d2fbee95ed))

## [0.21.1](https://github.com/2060-io/ayni-agent/compare/v0.21.0...v0.21.1) (2026-11-17)


### Bug Fixes

* **history:** what the system did is told to the model as a record, never in the agent's voice ([#85](https://github.com/2060-io/ayni-agent/issues/85)) ([5b8330b](https://github.com/2060-io/ayni-agent/commit/5b8330b91b3ef2e0388aa33d84ff859958925baf))

## [0.21.0](https://github.com/2060-io/ayni-agent/compare/v0.20.1...v0.21.0) (2026-11-17)


### Features

* **issuance:** a credential from a passport or an identity card: the chip read as a flow, kept as evidence, and a number by the document ([#83](https://github.com/2060-io/ayni-agent/issues/83)) ([b1c2f24](https://github.com/2060-io/ayni-agent/commit/b1c2f243dfc1d20c2bd7ab05910cd44af37f0a29))

## [0.20.1](https://github.com/2060-io/ayni-agent/compare/v0.20.0...v0.20.1) (2026-11-16)


### Bug Fixes

* **identity:** a wallet's decline is a decline, not a presentation that failed: Continue as guest lets the person in ([#81](https://github.com/2060-io/ayni-agent/issues/81)) ([8ea47ee](https://github.com/2060-io/ayni-agent/commit/8ea47eea67b94eb9472f13a9840b950d061e5f09))

## [0.20.0](https://github.com/2060-io/ayni-agent/compare/v0.19.1...v0.20.0) (2026-11-16)


### Features

* **identity:** a person authenticates in a step of its own, in one of three modes: required, offered, on request ([#79](https://github.com/2060-io/ayni-agent/issues/79)) ([ba3b3f1](https://github.com/2060-io/ayni-agent/commit/ba3b3f1d8bea2f4a6e76ee26e14428f47b2b24b6))

## [0.19.1](https://github.com/2060-io/ayni-agent/compare/v0.19.0...v0.19.1) (2026-11-15)


### Bug Fixes

* the agent speaks again after a wait, knows how an offer ended, and serves in flow mode a peer that uses flows ([#77](https://github.com/2060-io/ayni-agent/issues/77)) ([04a8c1d](https://github.com/2060-io/ayni-agent/commit/04a8c1d0f80cfbf0a8437a7db5124e8bf920090f))

## [0.19.0](https://github.com/2060-io/ayni-agent/compare/v0.18.0...v0.19.0) (2026-11-15)


### Features

* **identity:** the agent tells a peer where it stands, and a session grant names its endpoint ([#74](https://github.com/2060-io/ayni-agent/issues/74)) ([5e2fba2](https://github.com/2060-io/ayni-agent/commit/5e2fba205d530a2006d1e2dbcb3dc4c8761f8dea))

## [0.18.0](https://github.com/2060-io/ayni-agent/compare/v0.17.0...v0.18.0) (2026-11-15)


### Features

* **issuance:** a profile names its credential by schema, and the agent finds or creates its definition ([#71](https://github.com/2060-io/ayni-agent/issues/71)) ([8ca9243](https://github.com/2060-io/ayni-agent/commit/8ca9243124981443886529d0297421ae96aa744b))

## [0.17.0](https://github.com/2060-io/ayni-agent/compare/v0.16.0...v0.17.0) (2026-11-15)


### Features

* **issuance:** an identifier of the subject, derived from the Principal, numbers the holders of a credential ([#69](https://github.com/2060-io/ayni-agent/issues/69)) ([e62d100](https://github.com/2060-io/ayni-agent/commit/e62d10035056ee324957c49c636a52ff0dc895c2))

## [0.16.0](https://github.com/2060-io/ayni-agent/compare/v0.15.0...v0.16.0) (2026-11-15)


### ⚠ BREAKING CHANGES

* **identity:** identity.unidentifiedPeers leaves the agent-pack and the UNIDENTIFIED_PEERS variable is no longer read. An agent that asked on connect and admitted a person who declined now refuses them: ask on demand instead.
* **evidence:** a Principal no longer keeps every attribute of its identity credential, and the model is no longer told the person's name, unless the agent-pack stores the attribute (identity.authentication.store) and makes it visible (modelVisible). Memory schema 3.3.0 adds the evidence table and drops the unused credential_presentations table.
* **identity:** the agent-pack loses identity.recognizedBackingIdentities and identity.credentials.badge; it gains identity.authentication and identity.organizations. The DIDComm agent must report the issuer of each presented credential (VS Agent from v2.0.0-dev.110).

### Features

* **evidence:** one record per verification, values sealed and kept as the pack says; the model reads what the pack makes visible ([#66](https://github.com/2060-io/ayni-agent/issues/66)) ([9f6b52c](https://github.com/2060-io/ayni-agent/commit/9f6b52c929a4c42c6b862a4fafdd47bccdb5e4ce))
* **identity:** a person is the organization of the issuer, the schema and the badge number; organizations by patterns ([#63](https://github.com/2060-io/ayni-agent/issues/63)) ([4c67d23](https://github.com/2060-io/ayni-agent/commit/4c67d23d20a28323ce81606c1e0068046bab33fb))
* **identity:** the authentication asked on connect or on demand, binding after connect, and the presentation catalog ([#67](https://github.com/2060-io/ayni-agent/issues/67)) ([551380d](https://github.com/2060-io/ayni-agent/commit/551380d97ac40051780d16c380f20c3a451efd14))
* **issuance:** the agent issues credentials whose every claim has a source; the model names the credential and nothing else ([#68](https://github.com/2060-io/ayni-agent/issues/68)) ([963f4bf](https://github.com/2060-io/ayni-agent/commit/963f4bf045370bfedc3dda22afd2300284f8f422))


### Bug Fixes

* **process:** a reply that ends as the process ends is told to its client to the end ([#65](https://github.com/2060-io/ayni-agent/issues/65)) ([5a45449](https://github.com/2060-io/ayni-agent/commit/5a454499c79ecda1043990b93fd8c83851be8448))

## [0.15.0](https://github.com/2060-io/ayni-agent/compare/v0.14.1...v0.15.0) (2026-11-14)


### Features

* **voice:** a voice note keeps the length and the waveform its recorder measured ([#62](https://github.com/2060-io/ayni-agent/issues/62)) ([7d7e4e9](https://github.com/2060-io/ayni-agent/commit/7d7e4e96ccbb6a9e0844d7676e2a13ae801ccbd7))


### Bug Fixes

* **history:** a voice note of the person is one message, not its attachment and a text ([#60](https://github.com/2060-io/ayni-agent/issues/60)) ([8ffd20f](https://github.com/2060-io/ayni-agent/commit/8ffd20f1d40cc931c7f4e5c53d3331ccab04a674))
* **process:** one agent process on a store, kept by a lock in the database; an ending process starts no turn ([#59](https://github.com/2060-io/ayni-agent/issues/59)) ([ce12af2](https://github.com/2060-io/ayni-agent/commit/ce12af2b047d24ce0ca743af8fc2d778db55c3c1))

## [0.14.1](https://github.com/2060-io/ayni-agent/compare/v0.14.0...v0.14.1) (2026-11-14)


### Bug Fixes

* **chart:** one agent process at a time: the pod is replaced, not rolled ([#57](https://github.com/2060-io/ayni-agent/issues/57)) ([be0879a](https://github.com/2060-io/ayni-agent/commit/be0879aaed15fd5c2fd9e981d19c4690b053f594))

## [0.14.0](https://github.com/2060-io/ayni-agent/compare/v0.13.0...v0.14.0) (2026-11-14)


### Features

* **turns:** a message sent while the agent answers waits, and is answered next ([#55](https://github.com/2060-io/ayni-agent/issues/55)) ([7dd6385](https://github.com/2060-io/ayni-agent/commit/7dd6385b577cac7a37d2567b83b2663548421d0a))

## [0.13.0](https://github.com/2060-io/ayni-agent/compare/v0.12.0...v0.13.0) (2026-11-14)


### Features

* **uploads:** an upload is named by the field the client sends ([#53](https://github.com/2060-io/ayni-agent/issues/53)) ([31b2df8](https://github.com/2060-io/ayni-agent/commit/31b2df86f14f34251be4e17edbce34f18c855ec2))

## [0.12.0](https://github.com/2060-io/ayni-agent/compare/v0.11.0...v0.12.0) (2026-11-13)


### Features

* **replies:** a reply quotes a media message by what it is ([#51](https://github.com/2060-io/ayni-agent/issues/51)) ([3d36d4e](https://github.com/2060-io/ayni-agent/commit/3d36d4e3e8cdf938fef415d245b0fef881d8e0d0))

## [0.11.0](https://github.com/2060-io/ayni-agent/compare/v0.10.0...v0.11.0) (2026-11-12)


### Features

* **conversations:** shared read state, one marker per conversation ([#49](https://github.com/2060-io/ayni-agent/issues/49)) ([d764b14](https://github.com/2060-io/ayni-agent/commit/d764b14b0b9cedb2392b2355748bb9756aff538f))

## [0.10.0](https://github.com/2060-io/ayni-agent/compare/v0.9.1...v0.10.0) (2026-11-12)


### Features

* **sessions:** a bound session or none (silent creation) ([#47](https://github.com/2060-io/ayni-agent/issues/47)) ([0b8096d](https://github.com/2060-io/ayni-agent/commit/0b8096dda635af67a4349bbba984c80f511d4bc0))


### Bug Fixes

* **conversations:** opening a conversation is not activity in it ([#46](https://github.com/2060-io/ayni-agent/issues/46)) ([0cec54f](https://github.com/2060-io/ayni-agent/commit/0cec54f057d7f5c68895bc76043e08991bbd328e))

## [0.9.1](https://github.com/2060-io/ayni-agent/compare/v0.9.0...v0.9.1) (2026-11-12)


### Bug Fixes

* **sessions:** a phone is never asked to link the session of its own app ([#44](https://github.com/2060-io/ayni-agent/issues/44)) ([f8c02cd](https://github.com/2060-io/ayni-agent/commit/f8c02cdd0a429119f5a6b10741d5eacfaa49b1e6))

## [0.9.0](https://github.com/2060-io/ayni-agent/compare/v0.8.0...v0.9.0) (2026-11-12)


### Features

* **conversations:** a rename, an archive or a closure is announced to every device of the person ([#42](https://github.com/2060-io/ayni-agent/issues/42)) ([c7d8a39](https://github.com/2060-io/ayni-agent/commit/c7d8a399ecac4afc304eab98f5852441c995272a))

## [0.8.0](https://github.com/2060-io/ayni-agent/compare/v0.7.3...v0.8.0) (2026-11-11)


### Features

* **conversations:** a conversation is one transcript on every device (mirror of a run, shared history) ([#39](https://github.com/2060-io/ayni-agent/issues/39)) ([c29d8dd](https://github.com/2060-io/ayni-agent/commit/c29d8dd1431a9aa885343d17f7ba7b6b098675c5))

## [0.7.3](https://github.com/2060-io/ayni-agent/compare/v0.7.2...v0.7.3) (2026-11-11)


### Bug Fixes

* **welcome:** greet the session that starts a conversation, never one that continues it ([#37](https://github.com/2060-io/ayni-agent/issues/37)) ([933533f](https://github.com/2060-io/ayni-agent/commit/933533fcdeed4534fc0480e40c1741d09d7fab00))

## [0.7.2](https://github.com/2060-io/ayni-agent/compare/v0.7.1...v0.7.2) (2026-11-11)


### Bug Fixes

* **reactions:** a reaction on a message of an earlier session of the conversation is kept ([#35](https://github.com/2060-io/ayni-agent/issues/35)) ([ad7e9cc](https://github.com/2060-io/ayni-agent/commit/ad7e9cce51e4b0c683747f4f90e1756cc4e49791))

## [0.7.1](https://github.com/2060-io/ayni-agent/compare/v0.7.0...v0.7.1) (2026-11-03)


### Bug Fixes

* **uploads:** map the m4a and aac aliases an iPhone sends to audio/mp4 before the descriptor check ([#32](https://github.com/2060-io/ayni-agent/issues/32)) ([4ff57f0](https://github.com/2060-io/ayni-agent/commit/4ff57f00638f3ae2a16cdf10bf8edf6d8ab7cdc3))

## [0.7.0](https://github.com/2060-io/ayni-agent/compare/v0.6.1...v0.7.0) (2026-11-03)


### Features

* **welcome:** transcribe voice notes with OpenAI (STT_API_KEY from the deployment, whisper-1 unless STT_MODEL) ([#30](https://github.com/2060-io/ayni-agent/issues/30)) ([a1f6054](https://github.com/2060-io/ayni-agent/commit/a1f6054624651d0d24388f4be169d52b8fdb6174))

## [0.6.1](https://github.com/2060-io/ayni-agent/compare/v0.6.0...v0.6.1) (2026-11-03)


### Bug Fixes

* **binding:** wait for the disclosure on a handshake reuse and ask again as a flow when it arrives late ([#28](https://github.com/2060-io/ayni-agent/issues/28)) ([42ecf13](https://github.com/2060-io/ayni-agent/commit/42ecf13a8c23c4f46aa392be0d9f8e6b230beeec)), closes [#27](https://github.com/2060-io/ayni-agent/issues/27)

## [0.6.0](https://github.com/2060-io/ayni-agent/compare/v0.5.0...v0.6.0) (2026-11-02)


### Features

* **agui-profile:** profile 3.1 (session grant, flows, client platform, ayni.flow, app links) and npm publishing ([2b23e50](https://github.com/2060-io/ayni-agent/commit/2b23e50d2fb5712c0ffefdce60c1557d77ea2bc7))
* **agui-profile:** profile 3.1 and npm publishing ([dd070a1](https://github.com/2060-io/ayni-agent/commit/dd070a1a64b75ec57addef32b635cf11add2202c))
* **didcomm:** per-peer capability profile and flow mode for wallets that disclose ayni-flow/1.0 ([#21](https://github.com/2060-io/ayni-agent/issues/21)) ([702ff0c](https://github.com/2060-io/ayni-agent/commit/702ff0c7fc488472da496ed00d97736de2b8aaec))
* **flows:** flows as entries on flow-capable wallets; identity, device challenge and binding as flows (D55) ([#22](https://github.com/2060-io/ayni-agent/issues/22)) ([c333987](https://github.com/2060-io/ayni-agent/commit/c33398731112684ff578a5074e9409ec557f7e3c))
* **flows:** wake-ups through notify and attested approvals as authorize flows (D57, D58) ([#24](https://github.com/2060-io/ayni-agent/issues/24)) ([56b6a70](https://github.com/2060-io/ayni-agent/commit/56b6a70c98301c3ae260504903b812af33628203))
* **sessions:** session grant for flow-capable wallets, client platform and description (D56) ([#23](https://github.com/2060-io/ayni-agent/issues/23)) ([6fb7b67](https://github.com/2060-io/ayni-agent/commit/6fb7b677512d3637d7a54d24dede171da2b28d53))
* **welcome:** Welcome pack v4 with app links, APP_LINK_BASE platform rule, reissue answered (CC-WEL, D55) ([#26](https://github.com/2060-io/ayni-agent/issues/26)) ([7946cb6](https://github.com/2060-io/ayni-agent/commit/7946cb681590b0c082e2f4d8966210ea542c9d1f))


### Bug Fixes

* **flows:** persist the authorize flow reference so a restart still answers and closes it ([#25](https://github.com/2060-io/ayni-agent/issues/25)) ([0b1ed8a](https://github.com/2060-io/ayni-agent/commit/0b1ed8ac4df95d3578585106d28a17db34ece2df))

## [0.5.0](https://github.com/2060-io/ayni-agent/compare/v0.4.0...v0.5.0) (2026-10-16)


### Features

* **identity:** identity.unidentifiedPeers admits wallets without a valid identity credential (D53, IDENT-RES-007) ([ccd844e](https://github.com/2060-io/ayni-agent/commit/ccd844ef5fa05925f420a9c8ecc9e0f0690a7aad))
* **identity:** identity.unidentifiedPeers admits wallets without a valid identity credential (D53) ([ab659ca](https://github.com/2060-io/ayni-agent/commit/ab659ca2ffdda29aec8a8084b13290cfbf3f3934))

## [0.4.0](https://github.com/2060-io/ayni-agent/compare/v0.3.2...v0.4.0) (2026-10-16)


### Features

* **history:** a message the client sent keeps the id the client gave it (PROF-HIST-006 externalId) ([3faaf46](https://github.com/2060-io/ayni-agent/commit/3faaf46dfe7c4e03beae5684bb4f41e811d10c0b))
* **history:** a message the client sent keeps the id the client gave it (PROF-HIST-006 externalId) ([b24cdb2](https://github.com/2060-io/ayni-agent/commit/b24cdb2366af8c4c3062882e23de8d6570680050))

## [0.3.2](https://github.com/2060-io/ayni-agent/compare/v0.3.1...v0.3.2) (2026-10-15)


### Bug Fixes

* **docker:** ship the profile package's JSON schemas in the runtime image ([6a5556b](https://github.com/2060-io/ayni-agent/commit/6a5556bf57ac04a428a71ddee0f040a5a7fb8770))
* **docker:** ship the profile package's JSON schemas in the runtime image ([7f11967](https://github.com/2060-io/ayni-agent/commit/7f11967eeaad514d36b16f68d39d6563eda983db))

## [0.3.1](https://github.com/2060-io/ayni-agent/compare/v0.3.0...v0.3.1) (2026-10-14)


### Bug Fixes

* **chart:** name the chart ayni-agent-chart so it no longer overwrites the image tag ([d29d71e](https://github.com/2060-io/ayni-agent/commit/d29d71efc347e922daf6e63f8a8afe4cc721c417))
* **chart:** name the chart ayni-agent-chart so it no longer overwrites the image tag on Docker Hub ([247b0dd](https://github.com/2060-io/ayni-agent/commit/247b0dd9583ee2dbd3d1eb4ee7ad7aa3658132fc))

## [0.3.0](https://github.com/2060-io/ayni-agent/compare/v0.2.0...v0.3.0) (2026-10-14)


### Features

* **chart:** ingress and inline agent-pack ConfigMap; the Welcome to Ayni pack ships in the image ([446aaae](https://github.com/2060-io/ayni-agent/commit/446aaaeeb695bc2e6b926cdb0508630bb0a02abb))
* **chart:** ingress, inline agent pack and the Welcome to Ayni pack ([74f0aac](https://github.com/2060-io/ayni-agent/commit/74f0aac72c39cee3a218899a3d0cb9e0de6225f6))

## [0.2.0](https://github.com/2060-io/ayni-agent/compare/v0.1.0...v0.2.0) (2026-10-14)


### Features

* **agui:** replies (replyTo) and one reaction per person per message in history (PROF-RUN-009, PROF-ACT-003, INTX-REACT-004) ([b7d2f1d](https://github.com/2060-io/ayni-agent/commit/b7d2f1def21222eb2c9237c7ce1062d9a9e965d0))
* **agui:** voiceNotes is advertised only when a real transcriber is configured ([2f8f9ce](https://github.com/2060-io/ayni-agent/commit/2f8f9ced0d1ae3472207bac3c32558a14da813cb))
* **binding:** re-link a known device from the phone (device handle, yes/no question, pick the code among three) ([29c0433](https://github.com/2060-io/ayni-agent/commit/29c0433c0f43a2c70cab4c29ba807f745ce45d00))
* **chart:** namespace value, default ayni ([61e2ef4](https://github.com/2060-io/ayni-agent/commit/61e2ef4444579074e585f6e38de7cb0cd260b3bb))
* **didcomm:** manual pairing of a web session by binding code ([505e9fa](https://github.com/2060-io/ayni-agent/commit/505e9fabcb554b9a8921b5c069b9a9449918334a))
* **didcomm:** re-send the contextual menu with every reply on the capability channel ([1aa590d](https://github.com/2060-io/ayni-agent/commit/1aa590d9a463b43d7c440f4232ce8e3d3d83b408))
* **didcomm:** received and viewed receipts for what the person sends (INTX-STATE-001) ([3f73b3d](https://github.com/2060-io/ayni-agent/commit/3f73b3d98ef25cee07e63ff8368a2cd547962b59))
* **identity:** declare the AG-UI descriptor as a HologramAgUI service of the DID Document at boot (IDENT-SELF-005) ([13e4a56](https://github.com/2060-io/ayni-agent/commit/13e4a56d840c8324695286888136fb4a6a07c706))
* **llm:** endpoint from LLM_BASE_URL, optional temperature, reasoning effort max (Kimi K3) ([157e8b0](https://github.com/2060-io/ayni-agent/commit/157e8b00e83b08249e3aa2bd9ed0c0f0339fcc71))
* **media:** PDF text reaches the model, attachments carry their sender, llm.multimodal from LLM_MULTIMODAL, short wire captions ([ad883f2](https://github.com/2060-io/ayni-agent/commit/ad883f251c1518f10be9bd7b31a7ef69ed6fdc98))
* **sessions:** a pairing continues the Principal's latest conversation (PROF-CONV-006); supersede closes bound sessions only, a waiting provisional session binds to the new channel ([fe55409](https://github.com/2060-io/ayni-agent/commit/fe55409930130708ca4eeeb0b96bd13c267b6a85))
* **sessions:** conversations owned by the Principal: record, list, rename, archive, unarchive, close for good; sessions attach by conversationId (D52, IDENT-SESS-010..013, PROF-CONV-001..005) ([b237fef](https://github.com/2060-io/ayni-agent/commit/b237fefe6f8e40009defc492a1dd8288b7a6721b))
* **sessions:** device pairing outlives sessions: device secret at binding, silent bind with deviceProof, rotation, revocation, devices endpoints and DIDComm linked-devices menu (D51, IDENT-DEV-001..005, PROF-SESS-010..012, PROF-BIND-010) ([bf2e130](https://github.com/2060-io/ayni-agent/commit/bf2e13082141afe7790f0ccd167a8aaef7480f78))
* **sessions:** resume a closed session (PROF-SESS-009, IDENT-SESS-009) ([300d464](https://github.com/2060-io/ayni-agent/commit/300d4648332dea7577c9c3a3dc2e469de3b8a200))
* the Ayni Agent runtime (ayni-spec v3) ([00254f5](https://github.com/2060-io/ayni-agent/commit/00254f59ccbf9c41c8191755fd8b03aa3d792924))
* the Hologram Agent runtime (hologram-spec v3) ([4a59d42](https://github.com/2060-io/ayni-agent/commit/4a59d425f857bd56ee157fe1d5115d49a0d87ed5))


### Bug Fixes

* **agui:** allow DELETE in the CORS preflight (session close from the browser) ([63f9285](https://github.com/2060-io/ayni-agent/commit/63f92859b1a7ce3e8ae7a7e0e575ed359749d87d))
* **agui:** allow PATCH in CORS for the conversation endpoints ([c4b0fd6](https://github.com/2060-io/ayni-agent/commit/c4b0fd624d67764d5f7091f4d2b39afb24ef477c))
* **didcomm:** menu question on the session connection ([265036a](https://github.com/2060-io/ayni-agent/commit/265036af514d0103378daa8b83283fe4ba031fc0))
* **media:** create the object store bucket at boot (S3ObjectStore.init was never called) ([eb70b2b](https://github.com/2060-io/ayni-agent/commit/eb70b2b11a29543280f15415455b2052355da303))
* **orchestrator:** keep bookkeeping entries out of the model context; one system message for compatible endpoints ([2b3535e](https://github.com/2060-io/ayni-agent/commit/2b3535e9809212b5e8898365c807c5592dfba52c))
* **sessions:** one open AG-UI session per device per conversation (IDENT-SESS-014) ([9ff76c4](https://github.com/2060-io/ayni-agent/commit/9ff76c402ccd819a9db8831c8c1dbdd3bb13cb09))
