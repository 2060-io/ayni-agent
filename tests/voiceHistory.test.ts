/**
 * A voice note of the person is one message (PROF-MAP-006): in history, and for the person's other devices, it is
 * its attachment, which carries the transcription. It used to come a second time as a text with the same words.
 */
import { describe, expect, it } from 'vitest'
import { entryToMessages } from '../src/channels/agui/mapping.js'
import { inboundEvents } from '../src/channels/agui/mirror.js'
import type { MessageAttachment, MessageEntry } from '../src/core/types.js'

const note = (over: Partial<MessageAttachment> = {}): MessageAttachment =>
  ({
    id: 'att_1',
    type: 'voice',
    mimeType: 'audio/mp4',
    textRepr: 'Call me back please',
    filename: 'voice-note.m4a',
    ...over,
  }) as MessageAttachment

const entry = (over: Partial<MessageEntry>): MessageEntry =>
  ({
    id: 'msg_1',
    sessionId: 'ses_1',
    principalId: 'prn_1',
    role: 'principal',
    sourceType: 'voice',
    text: 'Call me back please',
    completion: 'complete',
    attachments: [note()],
    externalId: 'u_run-1',
    createdAt: '2026-11-14T10:00:00.000Z',
    initiatedAt: '2026-11-14T10:00:00.000Z',
    ...over,
  }) as MessageEntry

describe('a voice note of the person (PROF-MAP-006)', () => {
  it('is one message in history: its attachment, with the transcription and the entry it belongs to', () => {
    const messages = entryToMessages(entry({}))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'att_1',
      role: 'activity',
      content: { attachmentId: 'att_1', type: 'voice', textRepr: 'Call me back please', role: 'user' },
      metadata: { entryId: 'msg_1', externalId: 'u_run-1' },
    })
  })

  it('goes once to the other devices of the person', () => {
    const events = inboundEvents(entry({}))
    expect(events.map((e) => e.type)).toEqual(['ACTIVITY_SNAPSHOT'])
  })

  it('keeps words the person added to it: they are a text of their own', () => {
    const messages = entryToMessages(entry({ text: 'For the meeting' }))
    expect(messages.map((m) => m.role)).toEqual(['activity', 'user'])
    expect(messages[1]).toMatchObject({ id: 'msg_1', content: 'For the meeting' })
  })

  it('stays readable as a text once its audio is gone', () => {
    const messages = entryToMessages(entry({ attachments: [] }))
    expect(messages).toEqual([expect.objectContaining({ id: 'msg_1', role: 'user', content: 'Call me back please' })])
  })

  it('leaves a text with a file, and a reply of the agent, as they were', () => {
    const withFile = entryToMessages(
      entry({ sourceType: 'text', text: 'Here it is', attachments: [note({ type: 'file', textRepr: '[file a.pdf]' })] })
    )
    expect(withFile.map((m) => m.role)).toEqual(['activity', 'user'])
    const agent = entryToMessages(entry({ role: 'agent', text: 'Call me back please' }))
    expect(agent.map((m) => m.role)).toEqual(['activity', 'assistant'])
  })
})
