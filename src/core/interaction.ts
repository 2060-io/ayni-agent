/** Welcome, state-aware contextual menus with badges, the /sessions command (D46, INTX-MENU-001..005). */

import type { ContextualMenuItem } from '@ayni.org/ayni-agui-profile'
import type { AgentPack, MenuItemDef } from '../config/packTypes.js'
import { nameForModel } from './evidence.js'
import type { Principal, Session } from './types.js'

export const PLATFORM_MENU = {
  sessions: 'ayni.sessions',
  link: 'ayni.link-session',
  approvals: 'ayni.approvals',
  devices: 'ayni.devices',
  identify: 'ayni.identify',
  issuePrefix: 'ayni.issue:',
  endSessionPrefix: 'ayni.end-session:',
} as const

export function greetingFor(pack: AgentPack, principal: Principal | null): string {
  // the greeting enters the conversation the model reads: it names the person only when the model may (D68)
  const name = nameForModel(pack, principal) ?? ''
  const template = pack.persona.greeting ?? `Welcome{userName}.`
  const rendered = template.replace('{userName}', name ? (template.includes('{userName}') ? name : '') : '')
  return rendered
    .replace(/\s+,/g, ',')
    .replace(/Welcome\./, 'Welcome.')
    .trim()
}

export function menuItemVisible(item: MenuItemDef, principal: Principal | null, bound: boolean): boolean {
  const when = item.visibleWhen ?? 'always'
  if (when === 'always') return true
  if (when === 'bound') return bound
  return !!principal && (item.roles ?? []).some((r) => principal.roles.includes(r))
}

/** The name the Ayni app gives as its client (PROF-SESS-014). */
export const AYNI_APP_CLIENT = 'ayni-app'

export function contextualMenuFor(
  pack: AgentPack,
  principal: Principal | null,
  session: Session,
  pendingApprovals: number
): ContextualMenuItem[] {
  const bound = session.state === 'bound'
  const items: ContextualMenuItem[] = (pack.persona.menu ?? [])
    .filter((m) => menuItemVisible(m, principal, bound))
    .map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.action.type === 'url' && m.action.url ? { url: m.action.url } : {}),
    }))
  // a DIDComm peer in chat mode keeps the item and its badge (INTX-APPR-006); an AG-UI session offers none, the
  // approver's requests being in the Notifications, and a flow-capable phone is sent no menu (D54, D114)
  if (bound && session.channelType === 'didcomm' && (pack.features?.approvals ?? true) && pendingApprovals > 0) {
    items.push({ id: PLATFORM_MENU.approvals, label: 'Approvals', badge: pendingApprovals })
  }
  // a guest may ask to authenticate, when the agent has an authentication schema (IDENT-RES-015). The Ayni app
  // has its own entry for it, in the service's menu, and is not sent this one
  if (
    bound &&
    principal?.connectionType === 'verifiable-user-agent' &&
    !principal.identityCredentialRef &&
    pack.identity.authentication?.length &&
    session.client?.name !== AYNI_APP_CLIENT
  ) {
    items.push({ id: PLATFORM_MENU.identify, label: 'Authenticate' })
  }
  // the credentials a person asks for themselves: the profiles whose trigger is `request` (INTX-ISSUE-008)
  if (bound && principal?.connectionType === 'verifiable-user-agent') {
    for (const [name, profile] of Object.entries(pack.issuance ?? {})) {
      if (profile.trigger !== 'request') continue
      if (profile.roles?.length && !profile.roles.some((r) => principal.roles.includes(r))) continue
      items.push({ id: `${PLATFORM_MENU.issuePrefix}${name}`, label: `Get ${profile.label ?? name}` })
    }
  }
  if (bound && session.channelType === 'didcomm') {
    items.push({ id: PLATFORM_MENU.link, label: 'Link a web session' })
    items.push({ id: PLATFORM_MENU.sessions, label: 'Sessions' })
    items.push({ id: PLATFORM_MENU.devices, label: 'Linked devices' })
  }
  return items
}

/** "Ayni on iPhone" when the client described itself, else "name on platform" (CHAN-BIND-015). */
export function describeClient(client: { name: string; platform: string; description?: string }): string {
  return client.description ? `${client.description} (${client.platform})` : `${client.name} on ${client.platform}`
}

/** The Principal's paired devices, numbered for the "unlink <n>" reply (INTX-MENU-007). */
export function describeDevices(
  devices: {
    handle: string
    client: { name: string; platform: string; description?: string }
    createdAt: string
    lastUsedAt?: string
  }[]
): string {
  if (devices.length === 0) return 'No linked devices.'
  const when = (iso?: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?')
  return devices
    .map(
      (d, i) =>
        `${i + 1}. ${describeClient(d.client)}, linked ${when(d.createdAt)}, last used ${when(d.lastUsedAt ?? d.createdAt)}`
    )
    .join('\n')
}

export function describeSessions(sessions: Session[], current: Session): string {
  if (sessions.length === 0) return 'No open sessions.'
  return sessions
    .map((s, i) => {
      const client = s.client.description
        ? `${s.client.description} (${s.client.platform})`
        : `${s.client.name} ${s.client.version} (${s.client.platform})`.trim()
      const channel = s.channelType === 'ag-ui' ? 'web' : s.channelType === 'a2a' ? 'agent' : 'phone'
      const self = s.id === current.id ? ', this one' : ''
      return `${i + 1}. ${channel}: ${client}${self}, since ${s.boundAt?.slice(0, 16).replace('T', ' ') ?? '?'}, last activity ${s.lastActivityAt.slice(0, 16).replace('T', ' ')}`
    })
    .join('\n')
}
