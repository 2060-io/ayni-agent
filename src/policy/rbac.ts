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
