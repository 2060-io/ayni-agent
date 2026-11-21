/** Tool-access tiers per (role set, tool) (D12, D14, RBAC-TOOL-001..006). */
import type { ApprovalRule, ElevationRule, ToolAccess } from '../config/packTypes.js'

export type Tier = 'ALLOW' | 'APPROVAL' | 'REQUESTABLE' | 'DENY'

export interface TierResolution {
  tier: Tier
  approvalRule?: ApprovalRule
  elevationRule?: ElevationRule
}

function inRoleSet(access: ToolAccess | undefined, roles: string[], tool: string): boolean {
  if (!access) return false
  for (const role of roles) {
    const set = access.roles?.[role]
    if (set?.includes('*') || set?.includes(tool)) return true
  }
  return access.default === 'all'
}

/**
 * A tool the roles reach only through an elevation grant (RBAC-TOOL-004, D112): it is in the turn's tool list, and runs
 * only while a grant is held when it is called. A tool of the role's own set is not one, even with an elevation rule.
 */
export function needsGrant(resolution: TierResolution): boolean {
  return !!resolution.elevationRule
}

/** Whether a resolution lets a call run now: ALLOW or APPROVAL, by role or by a grant held (RBAC-TOOL-002..004). */
export function runsNow(resolution: TierResolution): boolean {
  return resolution.tier === 'ALLOW' || resolution.tier === 'APPROVAL'
}

/** Every (role set, tool) pair resolves to exactly one tier (RBAC-TOOL-001). */
export function resolveTier(
  access: ToolAccess | undefined,
  roles: string[],
  tool: string,
  hasActiveGrant: boolean
): TierResolution {
  const approvalRule = access?.approval?.find((r) => r.tools.includes(tool))
  const elevationRule = access?.elevation?.find((r) => r.tools.includes(tool))
  if (inRoleSet(access, roles, tool)) {
    return approvalRule ? { tier: 'APPROVAL', approvalRule } : { tier: 'ALLOW' }
  }
  if (elevationRule) {
    // an active grant makes the tool reachable for its window (PRIV-ELEV-004); high-stakes rules still apply
    if (hasActiveGrant)
      return approvalRule ? { tier: 'APPROVAL', approvalRule, elevationRule } : { tier: 'ALLOW', elevationRule }
    return { tier: 'REQUESTABLE', elevationRule }
  }
  return { tier: 'DENY' }
}
