/** Canonical entries to AG-UI messages (profile sections 6 to 8, PROF-MAP-002/006, PROF-HIST-001). */
import { ACTIVITY, type AttachmentActivity } from '@ayni.org/ayni-agui-profile'
import type { ApprovalRecord, MessageAttachment, MessageEntry } from '../../core/types.js'

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
    filename: a.filename,
    thumbnailId: a.thumbnailId,
  }
}

export function approvalValue(record: ApprovalRecord, viewerId: string, canDecide: boolean) {
  return {
    approvalId: record.id,
    kind: record.kind,
    tool: record.toolName,
    requester: { displayName: record.requesterName, role: record.requesterRole },
    purpose: record.purpose ? { id: record.purpose, label: record.purpose } : undefined,
    justification: record.justification,
    policy: { type: record.policy.type, value: record.policy.value, vetoOnRefusal: record.policy.vetoOnRefusal },
    expiresAt: record.expiresAt,
    status: record.status,
    own: record.requesterId === viewerId,
    canDecide,
    grantExpiresAt: record.grantExpiresAt,
    decidedBy: record.decisions.map((d) => d.approverName).join(', ') || undefined,
  }
}

/** The wire caption: a file's extracted text stays on the agent, the UI gets the name and a short excerpt. */
function caption(a: MessageAttachment): string {
  if (a.type !== 'file' || a.textRepr.length <= 200) return a.textRepr
  return `${a.textRepr.slice(0, 200).trim()}…`
}

/** One entry becomes one or more AG-UI messages (text and activities), transcript order preserved. */
export function entryToMessages(entry: MessageEntry): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const reactionMap = (entry.payload?.reactions ?? {}) as Record<string, { emoji: string; by: string }>
  const reactions = Object.values(reactionMap).map((r) => ({ emoji: r.emoji, by: r.by }))
  const meta = {
    createdAt: entry.createdAt,
    initiatedAt: entry.initiatedAt,
    sourceType: entry.sourceType,
    completion: entry.completion,
    reactions: reactions.length ? reactions : undefined,
    replyTo: entry.payload?.replyTo,
    externalId: entry.externalId,
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
      if (entry.sourceType !== 'media' || entry.role === 'agent' || entry.attachments.length === 0) {
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
    case 'auth-challenge':
      return [
        {
          id: entry.id,
          role: 'activity',
          activityType: ACTIVITY.capability,
          content: {
            kind: 'auth-challenge',
            challengeType: entry.payload?.type,
            status: entry.payload?.outcome,
            originSessionId: entry.sessionId,
          },
          metadata: meta,
        },
      ]
    case 'tool-call':
      return [] // progress is signalled with steps; tool names, arguments and results never reach the wire (PROF-MAP-005)
    default:
      return []
  }
}
