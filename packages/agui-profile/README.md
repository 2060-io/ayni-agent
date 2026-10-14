# @2060.io/ayni-agui-profile

TypeScript types, constants and JSON schemas of the **Ayni AG-UI Profile v3**, the wire contract
between a Ayni Agent (server) and a Ayni UI (client). The normative text lives in
`2060-io/ayni-spec`, `v3/ayni-agui-profile/profile.md`; this package follows it and cites
its `PROF-*` identifiers.

The package carries no AG-UI runtime: it describes the Ayni-specific parts (descriptor, session
endpoints, binding material, `ayni.*` custom events, `forwardedProps.ayni` actions,
`ayni.*` activity messages, `state.ayni`) and the few AG-UI message shapes it reuses.
