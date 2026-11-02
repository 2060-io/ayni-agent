/**
 * Per-peer capability profiles on DIDComm (D54, CHAN-PROF-006, FLOW-CAP-002): what a connected wallet
 * disclosed through discover-features. The DIDComm agent queries every new connection (and a reusing
 * peer without a recorded disclosure) and forwards the disclosure as a connection event in state
 * `updated` whose `metadata` maps each feature id to its JSON. A peer that discloses the Ayni flow
 * protocol is served in flow mode; the others are served as in v3.
 */
import type { KvRepo } from '../../store/types.js'
import { nowIso } from '../../util/ids.js'
import type { Logger } from '../../util/logger.js'

export const AYNI_FLOW_PROTOCOL = 'https://didcomm.org/ayni-flow/1.0'

export interface PeerProfile {
  connectionId: string
  /** protocol ids as disclosed (`https://didcomm.org/<name>/<version>`) */
  protocols: string[]
  /** roles per protocol when the disclosure named them */
  roles: Record<string, string[]>
  receivedAt: string
}

const KEY_PREFIX = 'didcomm.peer-profile:'

function parseFeature(id: string, raw: string): { id: string; type?: string; roles?: string[] } {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>
    return {
      id: String(json.id ?? id),
      type: typeof json['feature-type'] === 'string' ? (json['feature-type'] as string) : undefined,
      roles: Array.isArray(json.roles) ? json.roles.map(String) : undefined,
    }
  } catch {
    return { id }
  }
}

export class PeerProfiles {
  private readonly cache = new Map<string, PeerProfile>()
  private readonly waiters = new Map<string, ((profile: PeerProfile | undefined) => void)[]>()

  public constructor(
    private readonly kv: KvRepo,
    private readonly logger: Logger
  ) {}

  /** Records a disclosure forwarded by the DIDComm agent (connection event `updated` with feature metadata). */
  public async record(connectionId: string, metadata: Record<string, string>): Promise<PeerProfile> {
    const previous = await this.get(connectionId)
    const protocols = new Set(previous?.protocols ?? [])
    const roles: Record<string, string[]> = { ...(previous?.roles ?? {}) }
    for (const [key, raw] of Object.entries(metadata)) {
      const feature = parseFeature(key, raw)
      if (feature.type && feature.type !== 'protocol') continue
      protocols.add(feature.id)
      if (feature.roles) roles[feature.id] = feature.roles
    }
    const profile: PeerProfile = { connectionId, protocols: [...protocols].sort(), roles, receivedAt: nowIso() }
    this.cache.set(connectionId, profile)
    await this.kv.set(KEY_PREFIX + connectionId, JSON.stringify(profile))
    this.logger.debug(
      { connectionId, protocols: profile.protocols.length, flowCapable: isFlowCapable(profile) },
      'peer profile recorded'
    )
    for (const resolve of this.waiters.get(connectionId) ?? []) resolve(profile)
    this.waiters.delete(connectionId)
    return profile
  }

  public async get(connectionId: string): Promise<PeerProfile | undefined> {
    const cached = this.cache.get(connectionId)
    if (cached) return cached
    const stored = await this.kv.get(KEY_PREFIX + connectionId)
    if (!stored) return undefined
    const profile = JSON.parse(stored) as PeerProfile
    this.cache.set(connectionId, profile)
    return profile
  }

  /**
   * The disclosure arrives asynchronously after the connection completes; a caller that must decide
   * the serving mode (welcome or not) waits briefly for it when the DIDComm agent announced a query.
   */
  public async awaitDisclosure(connectionId: string, timeoutMs: number): Promise<PeerProfile | undefined> {
    const known = await this.get(connectionId)
    if (known) return known
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = (this.waiters.get(connectionId) ?? []).filter((w) => w !== settle)
        if (list.length) this.waiters.set(connectionId, list)
        else this.waiters.delete(connectionId)
        resolve(undefined)
      }, timeoutMs)
      const settle = (profile: PeerProfile | undefined) => {
        clearTimeout(timer)
        resolve(profile)
      }
      this.waiters.set(connectionId, [...(this.waiters.get(connectionId) ?? []), settle])
    })
  }

  /** Whether the peer disclosed the carrier protocol (by full id or by `<name>/<major>.` prefix). */
  public async supports(connectionId: string, protocol: string): Promise<boolean> {
    const profile = await this.get(connectionId)
    return !!profile && supportsProtocol(profile, protocol)
  }

  public async isFlowCapable(connectionId: string): Promise<boolean> {
    const profile = await this.get(connectionId)
    return !!profile && isFlowCapable(profile)
  }

  /** A terminated connection takes its profile with it; a reconnecting wallet discloses again. */
  public async forget(connectionId: string): Promise<void> {
    this.cache.delete(connectionId)
    await this.kv.set(KEY_PREFIX + connectionId, '')
  }
}

function majorPrefix(protocol: string): string {
  const match = /^(.*\/)(\d+)\.\d+$/.exec(protocol)
  return match ? `${match[1]}${match[2]}.` : protocol
}

export function supportsProtocol(profile: PeerProfile, protocol: string): boolean {
  const prefix = majorPrefix(protocol)
  return profile.protocols.some((p) => p === protocol || p.startsWith(prefix))
}

export function isFlowCapable(profile: PeerProfile): boolean {
  return supportsProtocol(profile, AYNI_FLOW_PROTOCOL)
}
