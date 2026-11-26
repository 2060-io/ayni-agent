# @ayni.org/ayni-agui-profile

TypeScript types, constants and JSON schemas of the **Ayni AG-UI Profile 3.5**, the wire contract
between an Ayni Agent (server) and an Ayni UI (client: the browser UI or the Ayni app). The normative
text lives in `2060-io/ayni-spec`, `v4/ayni-agui-profile/profile.md`; this package follows it and cites
its `PROF-*` identifiers. The package version tracks the profile version.

The package carries no AG-UI runtime: it describes the Ayni-specific parts (descriptor, session
endpoints, binding material, the session grant, `ayni.*` custom events, `forwardedProps.ayni` actions,
`ayni.*` activity messages including the `ayni.flow` card, `state.ayni`, the app links of §10, from 3.3
the spaces, the person's memories and preferences and the deletion window of a message, from 3.4 the tools of
a space, the confirmation card of a tool call and the sources of replies and conversations, and from 3.5 each person's
own accounts: Your accounts, the Connect card and `ayni.connections.changed`; from 3.5.1, the amendment of D114:
the Notifications of a space and of the agent, `ayni.space.notifications.changed`, the resend of an approval to the
phone, and `ayni.approval.request` withdrawn; from 3.5.2, the binding goal code `ayni.link-session`, the closure
reason `replaced` and `features.visitors`; from 3.5.3, what the clean spec removed: `client.profileVersion`, the
routed kind `authorization` and `INTERRUPT_REASON`; from 3.5.4, space governance: one owner or none, the successor,
the stewards, the approval timeouts, the approval policy of a tool of a space, the progress of an approval and the
notices of a space's governance; from 3.5.5, admin access: `features.admin`, the admin state, Show Admin and Hide
Admin, `ayni.admin.changed`, Audit and Operations and their errors; from 3.5.6, a step-up's re-authentication routed as
`authentication`, the challenge types `device` and `document`, a tool's `stepUp` as the method types it asks, and
`ayni.messages.withheld` for a credential only; from 3.5.7, a person found by name in Audit; from 3.5.8, the tools of a
space by feature, each with one provider chosen among those its template allows, the change of provider, the location of
a feature with a contract and its choices, and the feature of every source a client is given) and the few AG-UI message
shapes it reuses.

```ts
import { APP_LINK_DOMAIN, buildAppLink, parseAppLink, PROFILE_VERSION } from '@ayni.org/ayni-agui-profile'

buildAppLink(APP_LINK_DOMAIN.devnet, 'wallet', ['card', 'cred-1'])
// https://app.dev.ayni.org/app/wallet/card/cred-1
parseAppLink('https://app.dev.ayni.org/app/explore?q=notary&utm=x', APP_LINK_DOMAIN.devnet)
// { route: 'explore', segments: [], params: { q: 'notary' } }
```

JSON schemas (draft 2020-12) are served under `schemas/`: `descriptor.schema.json`,
`create-session.schema.json`, `ayni-action.schema.json`.

Published to npm from this repository by the `npm-publish` workflow whenever `package.json` carries a
version that is not on npm yet.
