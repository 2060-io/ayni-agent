/** AG-UI event construction (protocol 1.0 shapes), without a runtime dependency on the SDK. */
export type AgUiEvent = Record<string, unknown> & { type: string; timestamp?: number }

const ts = () => ({ timestamp: Date.now() })

export const ev = {
  /** `mergedInto`: the run was answered by another's turn and has none of its own (PROF-RUN-012) */
  runStarted: (threadId: string, runId: string, mergedInto?: string): AgUiEvent => ({
    type: 'RUN_STARTED',
    threadId,
    runId,
    ...(mergedInto ? { mergedInto } : {}),
    ...ts(),
  }),
  runFinished: (threadId: string, runId: string, outcome?: Record<string, unknown>, result?: unknown): AgUiEvent => ({
    type: 'RUN_FINISHED',
    threadId,
    runId,
    ...(outcome ? { outcome } : {}),
    ...(result !== undefined ? { result } : {}),
    ...ts(),
  }),
  runError: (message: string, code: string): AgUiEvent => ({ type: 'RUN_ERROR', message, code, ...ts() }),
  stepStarted: (stepName: string): AgUiEvent => ({ type: 'STEP_STARTED', stepName, ...ts() }),
  stepFinished: (stepName: string): AgUiEvent => ({ type: 'STEP_FINISHED', stepName, ...ts() }),
  textStart: (messageId: string, role: 'assistant' | 'user' = 'assistant'): AgUiEvent => ({
    type: 'TEXT_MESSAGE_START',
    messageId,
    role,
    ...ts(),
  }),
  textContent: (messageId: string, delta: string): AgUiEvent => ({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId,
    delta,
    ...ts(),
  }),
  textEnd: (messageId: string): AgUiEvent => ({ type: 'TEXT_MESSAGE_END', messageId, ...ts() }),
  stateSnapshot: (snapshot: unknown): AgUiEvent => ({ type: 'STATE_SNAPSHOT', snapshot, ...ts() }),
  stateDelta: (delta: unknown[]): AgUiEvent => ({ type: 'STATE_DELTA', delta, ...ts() }),
  messagesSnapshot: (messages: unknown[]): AgUiEvent => ({ type: 'MESSAGES_SNAPSHOT', messages, ...ts() }),
  activitySnapshot: (messageId: string, activityType: string, content: Record<string, unknown>): AgUiEvent => ({
    type: 'ACTIVITY_SNAPSHOT',
    messageId,
    activityType,
    content,
    replace: true,
    ...ts(),
  }),
  custom: (name: string, value: unknown): AgUiEvent => ({ type: 'CUSTOM', name, value, ...ts() }),
}

export function sse(event: AgUiEvent, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`
}
