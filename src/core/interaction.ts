/** Welcome, state-aware contextual menus with badges, the /sessions command (D46, INTX-MENU-001..005). */

import type { ContextualMenuItem } from '@2060.io/hologram-agui-profile'
import type { AgentPack, MenuItemDef } from '../config/packTypes.js'
import type { Principal, Session } from './types.js'

export const PLATFORM_MENU = {
  sessions: 'hologram.sessions',
  approvals: 'hologram.approvals',
  endSessionPrefix: 'hologram.end-session:',
} as const

export function greetingFor(pack: AgentPack, principal: Principal | null): string {
  const name = principal?.identityAttributes.userName ?? ''
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
  if (bound && (pack.features?.approvals ?? true) && pendingApprovals > 0) {
    items.push({ id: PLATFORM_MENU.approvals, label: 'Approvals', badge: pendingApprovals })
  }
  if (bound && session.channelType === 'didcomm') items.push({ id: PLATFORM_MENU.sessions, label: 'Sessions' })
  return items
}

export function describeSessions(sessions: Session[], current: Session): string {
  if (sessions.length === 0) return 'No open sessions.'
  return sessions
    .map((s, i) => {
      const client = `${s.client.name} ${s.client.version} (${s.client.platform})`.trim()
      const channel = s.channelType === 'ag-ui' ? 'web' : s.channelType === 'a2a' ? 'agent' : 'phone'
      const self = s.id === current.id ? ', this one' : ''
      return `${i + 1}. ${channel}: ${client}${self}, since ${s.boundAt?.slice(0, 16).replace('T', ' ') ?? '?'}, last activity ${s.lastActivityAt.slice(0, 16).replace('T', ' ')}`
    })
    .join('\n')
}
