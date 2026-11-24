/** Bundled tools enabled through configuration (TOOL-HTTP-002, INTX-CRED-001, INTX-PREF-001, MEM-TIER-003, MEM-RAG-004). */

import {
  type IdentityRequestOutcome,
  identityOutcomeForModel,
  type PresentationRequestOutcome,
  presentationOutcomeForModel,
} from '../channels/didcomm/identityRequests.js'
import { AUTHENTICATION_ENTRY, hasPersonalSource } from '../config/pack.js'
import type { AgentPack, BundledName, ToolAccess } from '../config/packTypes.js'
import { bundledEnabled, bundledSource, challengeTypesOf, connectionTypeOf, featuresOf } from '../config/packTypes.js'
import type { ConnectionService } from '../core/connections.js'
import { conversationOf } from '../core/conversationOf.js'
import {
  EMAIL_CHECK_KIND,
  type EmailChecks,
  emailCancelForModel,
  emailResendForModel,
  emailStatusForModel,
} from '../core/emailCheck.js'
import type { EvidenceService } from '../core/evidence.js'
import { type IssuanceService, issuanceOutcomeForModel, offeredProfiles } from '../core/issuance.js'
import { LANGUAGE_PREFERENCE, languageTag } from '../core/serviceLanguage.js'
import type { Principal, Session } from '../core/types.js'
import type { MediaService } from '../media/service.js'
import type { RagService } from '../memory/rag.js'
import { MemoryService } from '../memory/service.js'
import type { StatsSink } from '../platform/stats.js'
import type { Store } from '../store/types.js'
import { nowIso } from '../util/ids.js'
import { bundledSourceOf } from './catalog.js'
import type { ToolSource, ToolSpec } from './types.js'

export interface BundledDeps {
  pack: AgentPack
  store: Store
  memory: MemoryService
  evidence: EvidenceService
  /** asks the wallet of the Principal for the authentication credential, on demand (IDENT-RES-015) */
  requestIdentity?: (principal: Principal, by: 'model' | 'person') => Promise<IdentityRequestOutcome>
  /** credential issuance, wired once the DIDComm side is (INTX-ISSUE) */
  issuance?: () => IssuanceService | undefined
  /** asks the wallet of the Principal for the credential of a catalog entry (INTX-PRES-003) */
  /** asks for a catalog entry from the conversation of `session`, which the flow names as its origin (INTX-FLOW-001) */
  requestPresentation?: (principal: Principal, entry: string, session: Session) => Promise<PresentationRequestOutcome>
  media: MediaService
  rag?: RagService
  stats: StatsSink
  /** the model sets a per-message reaction policy (INTX-REACT-001) */
  setReactionPolicy: (sessionId: string, policy: 'notify' | 'historize' | { notifyOn: string[] }) => void
  /** the email checks the code runs, which the model follows, renews or cancels (INTX-AUTH-016..018) */
  emailChecks?: () => Pick<EmailChecks, 'status' | 'resend' | 'cancel'> | undefined
  /** each person's own accounts: the Connect card the model offers (D108, TOOL-CONN-011) */
  connections?: () => Pick<ConnectionService, 'offer'> | undefined
}

/** What the model reads of its `offer_connection` (TOOL-CONN-011): never a word of an account. */
export function offerForModel(outcome: 'shown' | 'connected' | 'not-available' | 'unavailable'): string {
  switch (outcome) {
    case 'shown':
      return 'shown: the Connect card is in your reply. The person connects the account from it and writes again once connected; do not wait for it, and never ask for a password, a token or a key.'
    case 'connected':
      return 'connected: the person has connected this account; its tools come with their next message.'
    case 'not-available':
      return 'not-available: this is not an account the person can connect in this conversation.'
    case 'unavailable':
      return "unavailable: no device of this conversation can show a Connect card. Tell the person to connect the account in this agent's Your accounts."
  }
}

/** Tools every bound Principal may use regardless of role (their effect is scoped to the Principal). */
export const ALWAYS_ALLOWED: ToolAccess = { default: 'all' }

export class BundledToolSource implements ToolSource {
  public readonly id = 'bundled'
  public constructor(private readonly deps: BundledDeps) {}

  public async list(): Promise<ToolSpec[]> {
    const { pack } = this.deps
    const features = featuresOf(pack)
    // a bundled tool is on while a source names it (unless `enabled: false`), else by its default (TOOL-HTTP-002)
    const on = (name: BundledName) => bundledEnabled(pack, name)
    const source = (name: BundledName) => bundledSource(pack, name)?.[1]
    // the tier model of its tools is its source's `access`; a tool that acts on the Principal's own records is allowed to
    // every Principal while its source declares none, the others are denied (RBAC-TOOL-006)
    const accessOf = (name: BundledName, otherwise: ToolAccess | undefined) => source(name)?.access ?? otherwise
    const specs: Omit<ToolSpec, 'source' | 'rawName'>[] = []

    if (features.credentialTool && on('principalCredentials')) {
      specs.push({
        key: 'bundled:principal_credentials',
        name: 'principal_credentials',
        description:
          'Lists what this agent verified about the person (a presented credential: which one, its issuing organization, when, whether it is still usable) with the attributes you are allowed to read. Other attributes exist and are not shown.',
        parameters: { type: 'object', properties: {} },
        access: accessOf('principalCredentials', ALWAYS_ALLOWED),
        stepLabel: 'Checking credentials',
        invoke: async (_args, ctx) => {
          // the evidence of the Principal, with the attributes the pack makes visible and no other (INTX-CRED-001)
          const records = await this.deps.evidence.forModel(ctx.principal.id)
          if (!records.length) return { content: 'Nothing was presented.' }
          return { content: JSON.stringify(records) }
        },
      })
    }

    // the model asks the wallet for a credential by naming an entry of the pack, and nothing else: no schema,
    // no attribute, no recipient (D68, D69, INTX-PRES-003). The authentication entry is for an unidentified
    // person only (IDENT-RES-015); a catalog entry is for a peer of the subject kind of its schema.
    const onDemand = Object.entries(pack.presentations ?? {}).filter(([, e]) => e.request === 'on-demand')
    const authenticates = !!pack.identity.authentication?.combinations?.length
    if ((authenticates || onDemand.length) && on('requestPresentation')) {
      const mayIdentify = (principal: Principal) =>
        authenticates && principal.connectionType === 'verifiable-user-agent' && !principal.identityCredentialRef
      const offered = (principal: Principal) =>
        onDemand.filter(([, e]) => connectionTypeOf(e.subjectKind) === principal.connectionType)
      specs.push({
        key: 'bundled:request_presentation',
        name: 'request_presentation',
        description: [
          'Asks the wallet of the peer for a credential this agent accepts, by the name of its entry. The call sends the request and waits for the answer, given in the wallet, which may take a minute: before you call, nothing has been asked. You get a status, never the content of the credential. After it returns, tell the person what happened.',
          ...(authenticates
            ? [
                'authentication: the person authenticates on their phone, in one of the ways this agent accepts, which gives them their roles and their own conversations; only while they are not identified. Ask when they want something that needs it, or when they say they are ready.',
              ]
            : []),
          ...onDemand.map(([name, e]) => `${name}: ${e.purpose}`),
        ].join('\n'),
        parameters: {
          type: 'object',
          required: ['entry'],
          additionalProperties: false,
          properties: {
            entry: {
              type: 'string',
              enum: [...(authenticates ? [AUTHENTICATION_ENTRY] : []), ...onDemand.map(([name]) => name)],
            },
          },
        },
        access: accessOf('requestPresentation', ALWAYS_ALLOWED),
        when: (principal) => mayIdentify(principal) || offered(principal).length > 0,
        stepLabel: 'Waiting for your wallet',
        invoke: async (args, ctx) => {
          const entry = String(args.entry ?? '')
          if (entry === AUTHENTICATION_ENTRY) {
            if (!authenticates) return { content: presentationOutcomeForModel('not-offered') }
            const outcome = (await this.deps.requestIdentity?.(ctx.principal, 'model')) ?? 'unavailable'
            return { content: identityOutcomeForModel(outcome), data: { entry, outcome } }
          }
          const outcome = offered(ctx.principal).some(([name]) => name === entry)
            ? ((await this.deps.requestPresentation?.(ctx.principal, entry, ctx.session)) ?? 'unavailable')
            : 'not-offered'
          return { content: presentationOutcomeForModel(outcome), data: { entry, outcome } }
        },
      })
    }

    // what the peer may receive and what is missing: read-only, no gate, never a value (INTX-ISSUE-005/006)
    const profiles = Object.entries(pack.issuance ?? {})
    if (profiles.length && on('credentialIssuance')) {
      specs.push({
        key: 'bundled:credential_requirements',
        name: 'credential_requirements',
        description:
          'Tells which credentials this agent can issue to the person, and for each whether it is held, ready or incomplete. For an incomplete one, each claim has a status and, when something can be done, an action: do what it says (for example request_presentation with the entry it names), then look again. A credential is ready when the only thing missing is what its own issuance obtains: an action issue_credential means that issuing it starts with the person reading their passport or identity card on their phone. You never see or supply a value: the agent fills the credential itself.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        access: accessOf('credentialIssuance', ALWAYS_ALLOWED),
        when: (principal) => offeredProfiles(pack, principal).length > 0,
        stepLabel: 'Checking what can be issued',
        invoke: async (_args, ctx) => {
          const requirements = (await this.deps.issuance?.()?.requirements(ctx.principal)) ?? []
          return { content: JSON.stringify(requirements) }
        },
      })
      // the model names a profile and nothing else: no claim, no recipient (D68, INTX-ISSUE-003). A profile
      // the peer or the agent starts is not in its list (RBAC-FILTER-003).
      const byModel = profiles.filter(([, p]) => (p.trigger ?? 'model') === 'model')
      if (byModel.length) {
        specs.push({
          key: 'bundled:issue_credential',
          name: 'issue_credential',
          description: [
            'Issues a credential of this agent to the person, to their wallet. Call credential_requirements first: issue only when the state is ready. For a credential made from a passport or an identity card, the call first asks the person to read the chip of their document with their phone, and can take up to five minutes; tell them before you call that their phone will ask for it. For a credential that needs an email check, the call ends your turn: the system itself asks the person in this conversation for their address and a code, and issues by itself once the code is right. The agent fills every claim from what it verified; you give the name of the credential and nothing else. The call sends the offer and waits for the person to answer it in their wallet, up to two minutes: it returns whether they accepted, declined, did not answer, or their wallet refused it. Before you call, nothing has been sent: do not say it was. After it returns, tell the person what happened.',
            undefined,
            ...byModel.map(([name, p]) => `${name}${p.label ? `: ${p.label}` : ''}`),
          ].join('\n'),
          parameters: {
            type: 'object',
            required: ['credential'],
            additionalProperties: false,
            properties: { credential: { type: 'string', enum: byModel.map(([name]) => name) } },
          },
          access: accessOf('credentialIssuance', ALWAYS_ALLOWED),
          when: (principal) => offeredProfiles(pack, principal).some(([, p]) => (p.trigger ?? 'model') === 'model'),
          stepLabel: 'Issuing your credential',
          invoke: async (args, ctx) => {
            const issuance = this.deps.issuance?.()
            if (!issuance) return { content: issuanceOutcomeForModel('unavailable') }
            const result = await issuance.issue(ctx.principal, ctx.session, String(args.credential ?? ''), 'model')
            return {
              content: issuanceOutcomeForModel(result.outcome, result.requirements, result.reason),
              data: { credential: args.credential, outcome: result.outcome },
              isError: result.outcome === 'failed',
              // an email check now waits in the conversation: the code asks, and the turn ends (INTX-AUTH-012)
              ...(result.ask
                ? {
                    endTurn: {
                      text: result.ask.text,
                      payload: { kind: EMAIL_CHECK_KIND, challengeId: result.ask.challengeId, step: 'question' },
                    },
                  }
                : {}),
            }
          },
        })
      }
    }

    // the email check, which the code runs: the model follows it, has a new code sent, or ends it, and never sees the
    // address or the code (decision 63, INTX-AUTH-016..018). Present only when a profile declares one.
    if (profiles.some(([, p]) => challengeTypesOf(p).includes('email'))) {
      specs.push({
        key: 'bundled:email_check',
        name: 'email_check',
        description:
          'The email check the system runs when a credential needs one (issue_credential): the system itself asks the person, in the conversation, for the address their organization knows them by, then for the code it emails there, and takes the message that carries either. You never see them and never ask for them; any other message of the person reaches you as usual. status: whether a check is waiting for the person, in this conversation or another, at which step (address or code), and the seconds, tries and resends left. resend: when the person says the code did not arrive, sends a new one to the same address; the previous code stops working and the ten minutes start again; at most three times per check, thirty seconds apart. cancel: ends the check, and nothing is issued. To use another address, cancel, then call issue_credential again.',
        parameters: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: { action: { type: 'string', enum: ['status', 'resend', 'cancel'] } },
        },
        access: ALWAYS_ALLOWED,
        stepLabel: 'Looking at your email check',
        invoke: async (args, ctx) => {
          const checks = this.deps.emailChecks?.()
          const action = String(args.action ?? '')
          const conversationId = conversationOf(ctx.session)
          if (action === 'status') {
            const status = checks ? await checks.status(ctx.principal.id, conversationId) : { waiting: false as const }
            return { content: emailStatusForModel(status), data: { action, waiting: status.waiting } }
          }
          if (action === 'resend') {
            const result = checks ? await checks.resend(ctx.principal.id, conversationId) : { outcome: 'none' as const }
            return { content: emailResendForModel(result), data: { action, outcome: result.outcome } }
          }
          if (action === 'cancel') {
            const cancelled = checks ? await checks.cancel(ctx.principal.id) : false
            return { content: emailCancelForModel(cancelled), data: { action, cancelled } }
          }
          return { content: 'Unknown action: use status, resend or cancel.', isError: true }
        },
      })
    }

    if (features.preferences && on('principalPreferences')) {
      specs.push({
        key: 'bundled:principal_preferences',
        name: 'principal_preferences',
        description:
          'Reads or stores a durable preference of the person (language, formatting, style). Preferences load automatically each turn. The language the person reads goes under the key language, as a BCP 47 tag (es, pt-BR): the messages the system writes itself follow it.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'set'] },
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['action'],
        },
        access: accessOf('principalPreferences', ALWAYS_ALLOWED),
        stepLabel: 'Updating preferences',
        invoke: async (args, ctx) => {
          if (args.action === 'set') {
            if (typeof args.key !== 'string' || typeof args.value !== 'string')
              return { content: 'key and value are required', isError: true }
            // the language is a tag the code reads (INTX-PREF-003): anything else is refused, in words
            let { key, value } = args
            if (key.trim().toLowerCase() === LANGUAGE_PREFERENCE) {
              key = LANGUAGE_PREFERENCE
              const tag = languageTag(value)
              if (!tag)
                return {
                  content: `${LANGUAGE_PREFERENCE} must be a BCP 47 language tag, such as es, fr or pt-BR: nothing was stored`,
                  isError: true,
                }
              value = tag
            }
            // through the memory service, which seals it (D77)
            await this.deps.memory.setPreference(ctx.principal, key, value)
            return { content: `preference ${key} stored` }
          }
          // a retrieval: through the scope predicate, logged (PRIV-SCOPE-003/006)
          const prefs = await this.deps.memory.preferences(ctx.principal, ctx.session)
          return { content: JSON.stringify(Object.fromEntries(prefs.map((p) => [p.key, p.value]))) }
        },
      })
    }

    if (features.workingMemory && on('workingMemory')) {
      specs.push({
        key: 'bundled:working_memory',
        name: 'working_memory',
        description:
          'Curates the durable notes about this person in the space of this conversation: add a note, update or remove one by id. The notes of this space are listed to you every turn; write them in the language the person speaks with you.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'update', 'remove'] },
            id: { type: 'string', description: 'note id for update and remove' },
            content: { type: 'string' },
          },
          required: ['action'],
        },
        access: accessOf('workingMemory', ALWAYS_ALLOWED),
        stepLabel: 'Updating notes',
        invoke: async (args, ctx) => {
          const content = typeof args.content === 'string' ? args.content.trim() : ''
          // the notes of the space of the conversation, and no other (MEM-SPACE-002)
          const spaceId = ctx.spaceId
          const changed = (memoryId: string, action: 'added' | 'changed' | 'removed', space: string) =>
            ctx.memoryChanged?.({ memoryId, spaceId: space, action })
          if (args.action === 'add') {
            if (!content) return { content: 'content is required', isError: true }
            // the note cites the message it came from: deleting that message within its window deletes the note, its
            // erasure by an operator flags it (decision 60, PRIV-ERASE-005)
            const note = await this.deps.memory.addNote(
              ctx.principal,
              content,
              ctx.inboundId ? [ctx.inboundId] : [],
              spaceId
            )
            await changed(note.id, 'added', MemoryService.spaceOfNote(note))
            return { content: `note ${note.id} added` }
          }
          if (typeof args.id !== 'string') return { content: 'id is required', isError: true }
          if (args.action === 'update') {
            if (!content) return { content: 'content is required', isError: true }
            const note = await this.deps.memory.updateNote(ctx.principal, args.id, content, {
              spaceId,
              from: ctx.inboundId,
            })
            if (note) await changed(note.id, 'changed', MemoryService.spaceOfNote(note))
            return { content: note ? `note ${args.id} updated` : 'note not found', isError: !note }
          }
          const note = await this.deps.memory.removeNote(ctx.principal, args.id, { spaceId })
          if (note) await changed(note.id, 'removed', MemoryService.spaceOfNote(note))
          return { content: note ? `note ${args.id} removed` : 'note not found', isError: !note }
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

    if (on('statistics')) {
      const statClass = source('statistics')?.defaultStatClass ?? 'conversation'
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
        access: accessOf('statistics', undefined),
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

    if (features.imageGeneration && on('generateImage')) {
      const provider = source('generateImage')?.provider
      specs.push({
        key: 'bundled:generate_image',
        name: 'generate_image',
        description: 'Generates an image from a prompt in the background; the image arrives as a separate message.',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        access: accessOf('generateImage', undefined),
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
    // the Connect card of a person's own account (D108, TOOL-CONN-011): a free `source`, checked in code, so that the
    // tool's definition stays the same from one turn to the next; the gate gives it only while one is to connect
    if (on('connections') && hasPersonalSource(pack)) {
      specs.push({
        key: 'bundled:offer_connection',
        name: 'offer_connection',
        description:
          'Shows the person a Connect card in your reply for one of the accounts the system record "Accounts this person can connect" lists, by its source id. The person connects from the card, never in the conversation. Answers shown, connected, not-available or unavailable.',
        parameters: {
          type: 'object',
          required: ['source'],
          additionalProperties: false,
          properties: { source: { type: 'string', description: 'the id of the source, as the record lists it' } },
        },
        access: accessOf('connections', ALWAYS_ALLOWED),
        stepLabel: 'Preparing a card',
        invoke: async (args, ctx) => {
          const service = this.deps.connections?.()
          const sourceId = typeof args.source === 'string' ? args.source : ''
          if (!service || !ctx.spaceId || !sourceId) return { content: offerForModel('not-available') }
          const outcome = await service.offer(ctx.principal, ctx.session, ctx.spaceId, sourceId, async (card) => {
            await ctx.connectCard?.(card)
          })
          return { content: offerForModel(outcome), data: { outcome } }
        },
      })
    }
    // each is a source of the catalog: the source that names its bundled tool, else its own name (TOOL-CAT-001)
    return specs.map((spec) => ({ ...spec, source: bundledSourceOf(pack, spec.name), rawName: spec.name }))
  }
}
