# @2060.io/hologram-agui-profile

TypeScript types, constants and JSON schemas of the **Hologram AG-UI Profile v3**, the wire contract
between a Hologram Agent (server) and a Hologram UI (client). The normative text lives in
`2060-io/hologram-spec`, `v3/hologram-agui-profile/profile.md`; this package follows it and cites
its `PROF-*` identifiers.

The package carries no AG-UI runtime: it describes the Hologram-specific parts (descriptor, session
endpoints, binding material, `hologram.*` custom events, `forwardedProps.hologram` actions,
`hologram.*` activity messages, `state.hologram`) and the few AG-UI message shapes it reuses.
