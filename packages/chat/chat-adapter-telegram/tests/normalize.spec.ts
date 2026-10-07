/** Update normalization against recorded-shape fixtures. */

import { describe, expect, it } from 'vitest'
import { callbackQueryId, inboundMessageId, normalizeUpdate, outboundMessageId, stripBotMention } from '../src/normalize.ts'
import * as fixtures from './fixtures/updates.ts'

const { BOT } = fixtures

describe('normalizeUpdate', () => {
  it('normalizes a private text message as addressed, with sender and chat-scoped id', () => {
    expect(normalizeUpdate(fixtures.privateText, BOT)).toEqual({
      type: 'message', messageId: '42:5', route: { kind: 'direct', chatId: '42' },
      sender: { userId: '42', isBot: false, displayName: 'Alice Liddell' },
      addressed: true, text: 'hello there', controlText: 'hello there', attachments: [], platformTime: 1_700_000_000_000,
    })
  })

  it('treats a group message as addressed only for a mention, a reply to the bot, or a command for this bot', () => {
    const mention = normalizeUpdate(fixtures.groupMention, BOT)
    expect(mention).toMatchObject({ addressed: true, route: { kind: 'group', chatId: '-100123', threadId: '9' }, controlText: 'summarize this', text: '@HarniBot summarize this' })
    expect(normalizeUpdate(fixtures.groupUnaddressed, BOT)).toMatchObject({ addressed: false })
    expect(normalizeUpdate(fixtures.groupCommandForBot, BOT)).toMatchObject({ addressed: true, controlText: '/status now' })
    expect(normalizeUpdate(fixtures.groupCommandForOtherBot, BOT)).toMatchObject({ addressed: false })
    expect(normalizeUpdate(fixtures.groupBareCommand, BOT)).toMatchObject({ addressed: true, controlText: '/help' })
    expect(normalizeUpdate(fixtures.replyToBot, BOT)).toMatchObject({ addressed: true, replyToMessageId: '-100123:3' })
  })

  it('without a known username only replies and bare commands address the bot', () => {
    expect(normalizeUpdate(fixtures.groupMention, { id: BOT.id })).toMatchObject({ addressed: false })
    expect(normalizeUpdate(fixtures.groupCommandForBot, { id: BOT.id })).toMatchObject({ addressed: false })
    expect(normalizeUpdate(fixtures.groupBareCommand, { id: BOT.id })).toMatchObject({ addressed: true })
  })

  it('extracts the largest photo and a document as attachment references', () => {
    expect(normalizeUpdate(fixtures.photoWithCaption, BOT)).toMatchObject({
      text: 'what is this?', attachments: [{ attachmentId: 'large', name: 'photo.jpg', mediaType: 'image/jpeg', bytes: 2_000 }],
    })
    expect(normalizeUpdate(fixtures.documentMessage, BOT)).toMatchObject({
      text: '', attachments: [{ attachmentId: 'doc-1', name: 'report.pdf', mediaType: 'application/pdf', bytes: 4_096 }],
    })
    const bare = normalizeUpdate({ update_id: 1, message: { message_id: 1, from: { id: 5, is_bot: false }, chat: { id: 5, type: 'private' }, photo: [{ file_id: 'p' }], document: { file_id: 'd' } } }, BOT)
    expect(bare).toMatchObject({ attachments: [{ attachmentId: 'p' }, { attachmentId: 'd' }], platformTime: 0 })
  })

  it('reports an edit without the addressed flag', () => {
    expect(normalizeUpdate(fixtures.editedMessage, BOT)).toEqual({
      type: 'message-edited', messageId: '42:5', route: { kind: 'direct', chatId: '42' },
      sender: { userId: '42', isBot: false, displayName: 'Alice Liddell' }, text: 'hello again', controlText: 'hello again', platformTime: 1_700_000_000_000,
    })
  })

  it('normalizes a button press into an interaction on the message chat', () => {
    expect(normalizeUpdate(fixtures.callback, BOT)).toEqual({
      type: 'interaction', interactionId: 'cb-1', actionId: 'approve:k1', route: { kind: 'direct', chatId: '42' },
      sender: { userId: '42', isBot: false, displayName: 'Alice Liddell' },
    })
    expect(normalizeUpdate(fixtures.groupCallbackInThread, BOT)).toMatchObject({ route: { kind: 'group', chatId: '-100123', threadId: '9' } })
    expect(callbackQueryId(fixtures.callback)).toBe('cb-1')
    expect(callbackQueryId(fixtures.privateText)).toBeUndefined()
  })

  it('flags bot senders, falls back to the username, and drops unsupported updates', () => {
    expect(normalizeUpdate(fixtures.botSender, BOT)).toMatchObject({ sender: { userId: '999', isBot: true, displayName: 'Other' } })
    expect(normalizeUpdate(fixtures.nameless, BOT)).toMatchObject({ sender: { displayName: 'anon' } })
    expect(normalizeUpdate({ update_id: 2, message: { message_id: 1, from: { id: 9, is_bot: false }, chat: { id: 9, type: 'private' }, text: 'x' } }, BOT)).toMatchObject({ sender: { userId: '9' } })
    const noName = normalizeUpdate({ update_id: 2, message: { message_id: 1, from: { id: 9, is_bot: false }, chat: { id: 9, type: 'private' }, text: 'x' } }, BOT)
    expect(noName && 'sender' in noName && noName.sender.displayName).toBeUndefined()
    for (const update of [fixtures.channelPost, null, 'text', {}, { message: { chat: { id: 1, type: 'private' } } },
      { message: { message_id: 1, from: { id: 'x' }, chat: { id: 1, type: 'private' } } },
      { callback_query: { id: 'x', data: 'd', from: { id: 1 }, message: { chat: { id: 1, type: 'channel' }, message_id: 1 } } },
      { callback_query: { id: 'x', from: { id: 1 }, message: { chat: { id: 1, type: 'private' }, message_id: 1 } } }]) {
      expect(normalizeUpdate(update, BOT)).toBeUndefined()
    }
  })
})

describe('message id helpers', () => {
  it('round-trips the chat-scoped id', () => {
    expect(inboundMessageId(-100123, 7)).toBe('-100123:7')
    expect(outboundMessageId('-100123:7')).toBe(7)
    expect(outboundMessageId('7')).toBe(7)
    expect(outboundMessageId('x')).toBeUndefined()
    expect(outboundMessageId('1:')).toBeUndefined()
  })

  it('strips the bot mention and command suffix only', () => {
    expect(stripBotMention('/cmd@HarniBot arg', 'HarniBot')).toBe('/cmd arg')
    expect(stripBotMention('hi @harnibot there', 'HarniBot')).toBe('hi there')
    expect(stripBotMention('mail me@harnibotx.com', 'HarniBot')).toBe('mail me@harnibotx.com')
    expect(stripBotMention('/cmd@Other arg', 'HarniBot')).toBe('/cmd@Other arg')
    expect(stripBotMention('  plain  ', undefined)).toBe('plain')
    expect(stripBotMention('a.b@c', 'a.b')).toBe('a.b@c')
  })
})
