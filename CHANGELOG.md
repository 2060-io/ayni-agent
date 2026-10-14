# Changelog

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
