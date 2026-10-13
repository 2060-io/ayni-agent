/** Bundled tools enabled through configuration (TOOL-HTTP-002, INTX-CRED-001, INTX-PREF-001, MEM-TIER-003, MEM-RAG-004). */
import type { AgentPack, ToolAccess } from '../config/packTypes.js'
import { featuresOf } from '../config/packTypes.js'
import type { MediaService } from '../media/service.js'
import type { RagService } from '../memory/rag.js'
import type { MemoryService } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import type { Store } from '../store/types.js'
import { nowIso } from '../util/ids.js'
import type { ToolSource, ToolSpec } from './types.js'

export interface BundledDeps {
  pack: AgentPack
  store: Store
  memory: MemoryService
  media: MediaService
  rag?: RagService
  stats: StatsSink
  /** the model sets a per-message reaction policy (INTX-REACT-001) */
  setReactionPolicy: (sessionId: string, policy: 'notify' | 'historize' | { notifyOn: string[] }) => void
}

/** Tools every bound Principal may use regardless of role (their effect is scoped to the Principal). */
export const ALWAYS_ALLOWED: ToolAccess = { default: 'all' }

export class BundledToolSource implements ToolSource {
  public readonly id = 'bundled'
  public constructor(private readonly deps: BundledDeps) {}

  public async list(): Promise<ToolSpec[]> {
    const { pack } = this.deps
    const features = featuresOf(pack)
    const bundled = pack.tools?.bundled ?? {}
    const access = pack.tools?.access
    const specs: ToolSpec[] = []

    if (features.credentialTool && bundled.principalCredentials?.enabled !== false) {
      specs.push({
        key: 'bundled:principal_credentials',
        name: 'principal_credentials',
        description: 'Lists the verified credentials the person presented to this agent (type, issuer, summary).',
        parameters: { type: 'object', properties: {} },
        access: ALWAYS_ALLOWED,
        stepLabel: 'Checking credentials',
        invoke: async (_args, ctx) => {
          const creds = await this.deps.store.credentials.list(ctx.principal.id)
          if (!creds.length) return { content: 'No credentials presented.' }
          return {
            content: JSON.stringify(
              creds.map((c) => ({ type: c.type, issuer: c.issuerDid, presentedAt: c.presentedAt, ...c.summary }))
            ),
          }
        },
      })
    }

    if (features.preferences && bundled.principalPreferences?.enabled !== false) {
      specs.push({
        key: 'bundled:principal_preferences',
        name: 'principal_preferences',
        description:
          'Reads or stores a durable preference of the person (language, formatting, style). Preferences load automatically each turn.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'set'] },
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['action'],
        },
        access: ALWAYS_ALLOWED,
        stepLabel: 'Updating preferences',
        invoke: async (args, ctx) => {
          if (args.action === 'set') {
            if (typeof args.key !== 'string' || typeof args.value !== 'string')
              return { content: 'key and value are required', isError: true }
            await this.deps.store.preferences.set({
              principalId: ctx.principal.id,
              key: args.key,
              value: args.value,
              updatedAt: nowIso(),
            })
            return { content: `preference ${args.key} stored` }
          }
          const prefs = await this.deps.store.preferences.list(ctx.principal.id)
          return { content: JSON.stringify(Object.fromEntries(prefs.map((p) => [p.key, p.value]))) }
        },
      })
    }

    if (features.workingMemory && bundled.workingMemory?.enabled !== false) {
      specs.push({
        key: 'bundled:working_memory',
        name: 'working_memory',
        description:
          'Curates the durable notes about this person: add a note, update or remove one by id. Notes are listed to you every turn.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'update', 'remove'] },
            id: { type: 'string', description: 'note id for update and remove' },
            content: { type: 'string' },
          },
          required: ['action'],
        },
        access: ALWAYS_ALLOWED,
        stepLabel: 'Updating notes',
        invoke: async (args, ctx) => {
          const content = typeof args.content === 'string' ? args.content.trim() : ''
          if (args.action === 'add') {
            if (!content) return { content: 'content is required', isError: true }
            const note = await this.deps.memory.addNote(ctx.principal, content, [])
            return { content: `note ${note.id} added` }
          }
          if (typeof args.id !== 'string') return { content: 'id is required', isError: true }
          if (args.action === 'update') {
            const ok = await this.deps.memory.updateNote(ctx.principal, args.id, content)
            return { content: ok ? `note ${args.id} updated` : 'note not found', isError: !ok }
          }
          const ok = await this.deps.memory.removeNote(ctx.principal, args.id)
          return { content: ok ? `note ${args.id} removed` : 'note not found', isError: !ok }
        },
      })
    }

    if (features.rag && this.deps.rag) {
      const rag = this.deps.rag
      specs.push({
        key: 'bundled:knowledge_search',
        name: 'knowledge_search',
        description: 'Searches the configured knowledge documents and returns the most relevant passages.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        access: ALWAYS_ALLOWED,
        stepLabel: 'Searching documents',
        invoke: async (args, ctx) => {
          const query = typeof args.query === 'string' ? args.query : ''
          const hits = await rag.search(ctx.principal, ctx.session, query)
          if (!hits.length) return { content: 'No relevant passage found.' }
          return { content: hits.map((h, i) => `[${i + 1}] (${h.sourceId}) ${h.chunkText}`).join('\n\n') }
        },
      })
    }

    if (features.reactions) {
      specs.push({
        key: 'bundled:set_reaction_policy',
        name: 'set_reaction_policy',
        description:
          'Sets how reactions to your next reply are treated: notify (you are told), historize (recorded only) or notify only on the given emojis.',
        parameters: {
          type: 'object',
          properties: {
            policy: { type: 'string', enum: ['notify', 'historize', 'conditional'] },
            emojis: { type: 'array', items: { type: 'string' } },
          },
          required: ['policy'],
        },
        access: ALWAYS_ALLOWED,
        invoke: async (args, ctx) => {
          const policy =
            args.policy === 'conditional'
              ? { notifyOn: Array.isArray(args.emojis) ? args.emojis.map(String) : [] }
              : args.policy === 'notify'
                ? 'notify'
                : 'historize'
          this.deps.setReactionPolicy(ctx.session.id, policy)
          return { content: 'reaction policy set' }
        },
      })
    }

    if (bundled.statistics?.enabled) {
      const statClass = bundled.statistics.defaultStatClass ?? 'conversation'
      specs.push({
        key: 'bundled:statistics',
        name: 'statistics',
        description: 'Aggregated statistics of this agent over a time range (count and sum per bucket).',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'ISO 8601 start' },
            to: { type: 'string', description: 'ISO 8601 end' },
            statClass: { type: 'string' },
            granularity: { type: 'string', enum: ['hour', 'day', 'month'] },
          },
        },
        access,
        stepLabel: 'Reading statistics',
        invoke: async (args) => {
          const to = typeof args.to === 'string' ? args.to : nowIso()
          const from =
            typeof args.from === 'string' ? args.from : new Date(Date.parse(to) - 30 * 86_400_000).toISOString()
          const rows = await this.deps.store.stats.query({
            from,
            to,
            statClass: typeof args.statClass === 'string' ? args.statClass : statClass,
            granularity: (args.granularity as 'hour' | 'day' | 'month') ?? 'day',
          })
          return { content: JSON.stringify(rows), data: rows }
        },
      })
    }

    if (features.imageGeneration && bundled.generateImage?.enabled) {
      const provider = bundled.generateImage.provider
      specs.push({
        key: 'bundled:generate_image',
        name: 'generate_image',
        description: 'Generates an image from a prompt in the background; the image arrives as a separate message.',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        access,
        stepLabel: 'Starting image generation',
        invoke: async (args, ctx) => {
          const prompt = typeof args.prompt === 'string' ? args.prompt : ''
          if (!prompt) return { content: 'prompt is required', isError: true }
          const result = this.deps.media.startImageGeneration(ctx.principal, ctx.session, prompt, provider)
          if ('error' in result) return { content: result.error, isError: true }
          this.deps.stats.emit('image-generation', 1)
          return { content: `generation started (entry ${result.entryId}); tell the person the image is on its way` }
        },
      })
    }
    return specs
  }
}
