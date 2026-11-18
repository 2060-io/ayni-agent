/**
 * The conversation a session's entries belong to (MEM-ENTRY-004, D76): the AG-UI conversation it serves; else the
 * first session of the chain it resumes; else itself. What `conversation-private` keys on.
 */
import type { Session } from './types.js'

export function conversationOf(session: Pick<Session, 'id' | 'conversationId' | 'rootSessionId'>): string {
  return session.conversationId ?? session.rootSessionId ?? session.id
}
