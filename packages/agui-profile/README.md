# @2060.io/ayni-agui-profile

TypeScript types, constants and JSON schemas of the **Ayni AG-UI Profile 3.1**, the wire contract
between an Ayni Agent (server) and an Ayni UI (client: the browser UI or the Ayni app). The normative
text lives in `2060-io/ayni-spec`, `v4/ayni-agui-profile/profile.md`; this package follows it and cites
its `PROF-*` identifiers. The package version tracks the profile version.

The package carries no AG-UI runtime: it describes the Ayni-specific parts (descriptor, session
endpoints, binding material, the session grant, `ayni.*` custom events, `forwardedProps.ayni` actions,
`ayni.*` activity messages including the `ayni.flow` card, `state.ayni`, the app links of §10) and the
few AG-UI message shapes it reuses.

```ts
import { APP_LINK_DOMAIN, buildAppLink, parseAppLink, PROFILE_VERSION } from '@2060.io/ayni-agui-profile'

buildAppLink(APP_LINK_DOMAIN.devnet, 'wallet', ['card', 'cred-1'])
// https://app.dev.ayni.org/app/wallet/card/cred-1
parseAppLink('https://app.dev.ayni.org/app/explore?q=notary&utm=x', APP_LINK_DOMAIN.devnet)
// { route: 'explore', segments: [], params: { q: 'notary' } }
```

JSON schemas (draft 2020-12) are served under `schemas/`: `descriptor.schema.json`,
`create-session.schema.json`, `ayni-action.schema.json`.

Published to npm from this repository by the `npm-publish` workflow whenever `package.json` carries a
version that is not on npm yet.
