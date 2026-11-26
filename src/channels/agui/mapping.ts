/** Canonical entries to AG-UI messages (profile sections 6 to 8, PROF-MAP-002/006, PROF-HIST-001). */
import { ACTIVITY, type AttachmentActivity } from '@ayni.org/ayni-agui-profile'
import { isCredentialWithheld, isLegacyEmailCheck } from '../../core/credentials.js'
import { CARD_STATE, type MessageAttachment, type MessageEntry } from '../../core/types.js'

export function attachmentActivity(a: MessageAttachment, role?: 'user' | 'assistant'): AttachmentActivity {
  return {
    attachmentId: a.id,
    type: a.type === 'credential' ? 'file' : a.type,
    mimeType: a.mimeType,
    textRepr: caption(a),
    role,
    size: a.size,
    width: a.width,
    height: a.height,
    duration: a.duration,
    waveform: a.waveform,
    filename: a.filename,
    thumbnailId: a.thumbnailId,
  }
}

/**
 * The reference a reply keeps to the message it answers (PROF-RUN-009). A media message is quoted by what it is:
 * `text` is its own words (a caption, the transcription of a voice note) and is empty when it has none, where it
 * used to be the placeholder that stands for the attachment (`[file photo.jpg]`). `about` is what the model is
 * told of it; a UI does not show it.
 */
export function replyReference(entry: MessageEntry) {
  const first = entry.attachments[0]
  const placeholder = entry.attachments.map((a) => a.textRepr).join('\n')
  const words = first && first.type !== 'voice' && entry.text === placeholder ? '' : entry.text
  return {
    id: entry.id,
    text: words.slice(0, 200),
    role: entry.role === 'agent' ? ('assistant' as const) : ('user' as const),
    ...(first
      ? {
          media: first.type === 'credential' ? ('file' as const) : first.type,
          ...(first.filename ? { filename: first.filename } : {}),
          ...(words ? {} : { about: entry.text.slice(0, 200) }),
        }
      : {}),
  }
}

/** The reference as a UI gets it: what the model is told of a media message stays on the agent. */
function wireReply(reference: unknown): unknown {
  if (!reference || typeof reference !== 'object') return reference
  const { about: _about, ...shown } = reference as Record<string, unknown>
  return shown
}

/** The wire caption: a file's extracted text stays on the agent, the UI gets the name and a short excerpt. */
function caption(a: MessageAttachment): string {
  if (a.type !== 'file' || a.textRepr.length <= 200) return a.textRepr
  return `${a.textRepr.slice(0, 200).trim()}…`
}

/** The ids or names in a payload field, when it is a list of texts. */
function texts(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}

/**
 * The sources of a message of the agent whose turn ran tools (PROF-TOOL-010): one item per source and account, by its id,
 * its title and whose account, and nothing more of a tool (PROF-TOOL-013).
 */
export function messageSources(
  entry: Pick<MessageEntry, 'sources'>,
  titleOf: (sourceId: string) => string,
  featureOf: (featureId: string | undefined, sourceId: string) => { id: string; title: string } | undefined = () =>
    undefined
): { source: string; title: string; feature?: { id: string; title: string }; account: string }[] | undefined {
  if (!entry.sources?.length) return undefined
  const seen = new Set<string>()
  const out: { source: string; title: string; feature?: { id: string; title: string }; account: string }[] = []
  for (const s of entry.sources) {
    const key = `${s.sourceId}|${s.accountKind}`
    if (seen.has(key)) continue
    seen.add(key)
    // the feature the source served when the reply was made (TOOL-FEAT-019, PROF-TOOL-010)
    const feature = featureOf(s.featureId, s.sourceId)
    out.push({
      source: s.sourceId,
      title: titleOf(s.sourceId),
      ...(feature ? { feature } : {}),
      account: s.accountKind,
    })
  }
  return out
}

/** One entry becomes one or more AG-UI messages (text and activities), transcript order preserved. */
export function entryToMessages(
  entry: MessageEntry,
  titleOf: (sourceId: string) => string = (id) => id,
  /** the feature a source served, by the id a reply recorded, else the source's own (PROF-TOOL-035) */
  featureOf?: (featureId: string | undefined, sourceId: string) => { id: string; title: string } | undefined
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const reactionMap = (entry.payload?.reactions ?? {}) as Record<string, { emoji: string; by: string }>
  const reactions = Object.values(reactionMap).map((r) => ({ emoji: r.emoji, by: r.by }))
  // what of the person's memory a reply was given: its Info lists it, empty lists for a message of the agent outside a
  // turn (decision 60, PROF-HIST-011)
  const spaceRefusal = entry.sourceType === 'refusal' && entry.payload?.kind === 'space-rules'
  const reply = entry.role === 'agent' && (['text', 'voice', 'media'].includes(entry.sourceType) || spaceRefusal)
  const usedMemories = reply ? (texts(entry.payload?.usedMemories) ?? []) : undefined
  const usedPreferences = reply ? (texts(entry.payload?.usedPreferences) ?? []) : undefined
  // the sources the turn's tools read (PROF-TOOL-010): on a message of the agent whose turn ran tools, and on no other
  const sources = entry.role === 'agent' ? messageSources(entry, titleOf, featureOf) : undefined
  const meta = {
    createdAt: entry.createdAt,
    initiatedAt: entry.initiatedAt,
    sourceType: entry.sourceType,
    completion: entry.completion,
    reactions: reactions.length ? reactions : undefined,
    replyTo: wireReply(entry.payload?.replyTo),
    externalId: entry.externalId,
    ...(usedMemories ? { usedMemories } : {}),
    ...(usedPreferences ? { usedPreferences } : {}),
    ...(sources ? { sources } : {}),
    // a message held back because it carried a credential, as the agent kept it (TOOL-ACCESS-014, PROF-HIST-013)
    ...(isCredentialWithheld(entry) ? { modelVisible: false as const, withheld: 'credential' as const } : {}),
  }
  switch (entry.sourceType) {
    case 'text':
    case 'voice':
    case 'media': {
      for (const a of entry.attachments) {
        out.push({
          id: a.id,
          role: 'activity',
          activityType: ACTIVITY.attachment,
          content: attachmentActivity(a, entry.role === 'agent' ? 'assistant' : 'user'),
          metadata: { entryId: entry.id, ...meta },
        })
      }
      // a voice note of the person is one message: its attachment, which carries the transcription (`textRepr`).
      // The entry's text is that same transcription, and is not sent a second time as a text (PROF-MAP-006)
      const voice = entry.attachments.find((a) => a.type === 'voice')
      const onlyTheNote = entry.sourceType === 'voice' && !!voice && entry.text === voice.textRepr
      const mediaOnly = entry.sourceType === 'media' || onlyTheNote
      if (!mediaOnly || entry.role === 'agent' || entry.attachments.length === 0) {
        out.push({
          id: entry.id,
          role: entry.role === 'agent' ? 'assistant' : entry.role === 'system' ? 'system' : 'user',
          content: entry.text,
          metadata: meta,
        })
      }
      if (entry.payload?.menuId !== undefined && entry.payload?.items) {
        out.pop()
        out.push({
          id: entry.id,
          role: 'activity',
          activityType: ACTIVITY.menu,
          content: {
            menuId: entry.id,
            prompt: entry.text,
            items: entry.payload.items,
            selectedItemId: entry.payload.selectedItemId,
          },
          metadata: meta,
        })
      }
      return out
    }
    case 'approval':
    case 'refusal':
      // the code's answer in a space whose rules do not allow the agent's model: a message (PROF-RUN-014)
      if (spaceRefusal) return [{ id: entry.id, role: 'assistant', content: entry.text, metadata: meta }]
      // what became of an approval's card is a record for the model; the devices read the card in its current status
      // (INTX-APPR-008, LLM-CACHE-004)
      if (entry.payload?.kind === CARD_STATE) return []
      // the card of a tool call, a confirmation still pending included, in its current status (PROF-TOOL-007/009)
      if (entry.payload?.card && typeof entry.payload.card === 'object')
        return [
          {
            id: entry.id,
            role: 'activity',
            activityType: ACTIVITY.approval,
            content: entry.payload.card,
            metadata: meta,
          },
        ]
      return [
        {
          id: entry.id,
          role: 'activity',
          activityType: ACTIVITY.approval,
          content: {
            approvalId: entry.payload?.approvalId,
            kind: entry.payload?.kind,
            tool: entry.payload?.toolName,
            status: entry.payload?.status,
            purpose: entry.payload?.purpose,
            text: entry.text,
          },
          metadata: meta,
        },
      ]
    case 'flow':
      return [
        {
          id: entry.id,
          role: 'activity',
          activityType: ACTIVITY.flow,
          content: entry.payload ?? {},
          metadata: { ...meta, flowId: entry.payload?.flowId },
        },
      ]
    case 'auth-challenge':
      // what an email check in a conversation recorded before the check moved to the phone (D128) is shown no more
      if (isLegacyEmailCheck(entry)) return []
      // a challenge served as a `confirm` flow is shown by its flow card; the note stays for the model (D55)
      if (entry.payload?.flowId && entry.payload?.kind !== 'authentication') return []
      // a step-up's re-authentication leaves its outcome only (D127, INTX-AUTH-006): kind `authentication`, no
      // challengeType; a device confirmation or a document read keeps its challengeType (profile §6)
      return [
        {
          id: entry.id,
          role: 'activity',
          activityType: ACTIVITY.capability,
          content: {
            kind: entry.payload?.kind === 'authentication' ? 'authentication' : 'auth-challenge',
            ...(entry.payload?.kind === 'authentication' ? {} : { challengeType: entry.payload?.type }),
            status: entry.payload?.outcome,
            originSessionId: entry.sessionId,
            ...(entry.payload?.kind === 'authentication' && typeof entry.payload.flowId === 'string'
              ? { flowId: entry.payload.flowId }
              : {}),
          },
          metadata: meta,
        },
      ]
    case 'tool-call':
      return [] // progress is signalled with steps; tool names, arguments and results never reach the wire (PROF-MAP-005)
    case 'state-update': {
      // the Connect card a reply showed (PROF-TOOL-020): its state comes from the person's accounts, never from the card
      if (entry.payload?.kind === 'connect' && entry.payload.card && typeof entry.payload.card === 'object')
        return [
          {
            id: entry.id,
            role: 'activity',
            activityType: ACTIVITY.connect,
            content: entry.payload.card,
            metadata: {
              entryId: entry.id,
              createdAt: entry.createdAt,
              initiatedAt: entry.initiatedAt,
              sourceType: entry.sourceType,
            },
          },
        ]
      // a memory the agent changed is a line of the transcript, never its content (PROF-HIST-012); other bookkeeping is not
      const p = entry.payload as { kind?: string; memoryId?: string; spaceId?: string; action?: string } | undefined
      if (p?.kind !== 'memory' || !p.memoryId) return []
      return [
        {
          id: entry.id,
          role: 'activity',
          activityType: ACTIVITY.memoryUpdate,
          content: { memoryId: p.memoryId, spaceId: p.spaceId, action: p.action },
          metadata: {
            entryId: entry.id,
            createdAt: entry.createdAt,
            initiatedAt: entry.initiatedAt,
            sourceType: entry.sourceType,
          },
        },
      ]
    }
    default:
      return []
  }
}

/** What a member of a space reads of a conversation its author shares with it: the messages of the transcript. */
const SHARED_TYPES = ['text', 'voice', 'media']

/**
 * An entry of a shared conversation, as a member of its space reads it (SPACE-SHARE-003, PROF-HIST-011): the person's and the
 * agent's messages only, without what is the author's own (the memories and preferences a reply used, the memory lines,
 * the cards of their requests and approvals).
 */
export function sharedEntryToMessages(
  entry: MessageEntry,
  titleOf: (sourceId: string) => string = (id) => id,
  featureOf?: (featureId: string | undefined, sourceId: string) => { id: string; title: string } | undefined
): Record<string, unknown>[] {
  if (!SHARED_TYPES.includes(entry.sourceType) || (entry.role !== 'principal' && entry.role !== 'agent')) return []
  if (entry.payload?.menuId !== undefined && entry.payload?.items) return []
  // the sources of a reply stay: the members read where what is shared came from (PROF-TOOL-010)
  return entryToMessages(entry, titleOf, featureOf).map((message) => {
    const { usedMemories: _m, usedPreferences: _p, ...metadata } = (message.metadata ?? {}) as Record<string, unknown>
    return { ...message, metadata }
  })
}
