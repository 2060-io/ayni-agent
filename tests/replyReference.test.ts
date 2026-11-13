/**
 * The reference a reply keeps to the message it answers (PROF-RUN-009): a media message is quoted by what it is,
 * never by the placeholder that stands for its attachment.
 */
import { describe, expect, it } from 'vitest'
import { entryToMessages, replyReference } from '../src/channels/agui/mapping.js'
import type { MessageAttachment, MessageEntry } from '../src/core/types.js'

const entry = (over: Partial<MessageEntry>): MessageEntry =>
  ({
    id: 'msg_1',
    sessionId: 'ses_1',
    principalId: 'prn_1',
    role: 'principal',
    sourceType: 'text',
    text: 'Hello',
    completion: 'complete',
    attachments: [],
    createdAt: '2026-11-13T10:00:00.000Z',
    initiatedAt: '2026-11-13T10:00:00.000Z',
    ...over,
  }) as MessageEntry

const attachment = (over: Partial<MessageAttachment>): MessageAttachment =>
  ({
    id: 'att_1',
    type: 'image',
    mimeType: 'image/jpeg',
    textRepr: '[file photo.jpg]',
    filename: 'photo.jpg',
    ...over,
  }) as MessageAttachment

describe('the reference of a reply', () => {
  it('quotes a text by its words', () => {
    expect(replyReference(entry({ role: 'agent', text: 'A long answer' }))).toEqual({
      id: 'msg_1',
      text: 'A long answer',
      role: 'assistant',
    })
  })

  it('quotes a picture with no caption by what it is, and tells the model what it holds', () => {
    const picture = entry({ sourceType: 'media', text: '[file photo.jpg]', attachments: [attachment({})] })
    expect(replyReference(picture)).toEqual({
      id: 'msg_1',
      text: '',
      role: 'user',
      media: 'image',
      filename: 'photo.jpg',
      about: '[file photo.jpg]',
    })
  })

  it('keeps the words a media message has of its own: a caption, the transcription of a voice note', () => {
    const captioned = entry({ sourceType: 'media', text: 'My drawing', attachments: [attachment({})] })
    expect(replyReference(captioned)).toMatchObject({ text: 'My drawing', media: 'image' })
    expect(replyReference(captioned)).not.toHaveProperty('about')
    const voice = entry({
      sourceType: 'voice',
      text: 'Call me back please',
      attachments: [
        attachment({ type: 'voice', mimeType: 'audio/mp4', textRepr: 'Call me back please', filename: undefined }),
      ],
    })
    expect(replyReference(voice)).toEqual({ id: 'msg_1', text: 'Call me back please', role: 'user', media: 'voice' })
  })

  it('gives a UI the reference without what the model is told', () => {
    const picture = entry({ id: 'msg_0', sourceType: 'media', text: '[file photo.jpg]', attachments: [attachment({})] })
    const reply = entry({ id: 'msg_2', text: 'What is this?', payload: { replyTo: replyReference(picture) } })
    const [message] = entryToMessages(reply)
    const metadata = message?.metadata as { replyTo: unknown } | undefined
    expect(metadata?.replyTo).toEqual({
      id: 'msg_0',
      text: '',
      role: 'user',
      media: 'image',
      filename: 'photo.jpg',
    })
  })

  it('a picture carries the reactions and the id of its message, which a UI names to react or reply', () => {
    const picture = entry({
      sourceType: 'media',
      text: '[file photo.jpg]',
      attachments: [attachment({})],
      payload: { reactions: { prn_1: { emoji: '❤️', by: 'Ana' } } },
    })
    const [activity] = entryToMessages(picture)
    expect(activity).toMatchObject({
      id: 'att_1',
      role: 'activity',
      metadata: { entryId: 'msg_1', reactions: [{ emoji: '❤️', by: 'Ana' }] },
    })
  })
})
