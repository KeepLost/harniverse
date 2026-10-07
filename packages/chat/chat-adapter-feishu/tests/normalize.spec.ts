/** Event normalization against recorded-shape fixtures. */

import { describe, expect, it } from 'vitest'
import { normalizeEvent, parseAttachmentId } from '../src/normalize.ts'
import * as fixtures from './fixtures/events.ts'

const bot = { openId: fixtures.BOT_OPEN_ID }

describe('normalizeEvent', () => {
  it('normalizes a p2p text message as addressed', () => {
    expect(normalizeEvent(fixtures.p2pText, bot)).toEqual({
      type: 'message', messageId: 'om_1', route: { kind: 'direct', chatId: 'oc_dm' }, sender: { userId: 'ou_alice', isBot: false },
      addressed: true, text: 'hello there', controlText: 'hello there', attachments: [], platformTime: 1_700_000_000_123,
    })
  })

  it('addresses a group message only through a mention of this bot, and strips that mention from the control text', () => {
    const mention = normalizeEvent(fixtures.groupMention, bot)
    expect(mention).toMatchObject({ addressed: true, route: { kind: 'group', chatId: 'oc_group' }, text: '@Harni summarize this with @Bob', controlText: 'summarize this with @Bob' })
    expect(normalizeEvent(fixtures.groupPlain, bot)).toMatchObject({ addressed: false })
    expect(normalizeEvent(fixtures.groupMention, {})).toMatchObject({ addressed: false })
    expect(normalizeEvent(fixtures.groupReply, bot)).toMatchObject({ addressed: true, replyToMessageId: 'om_0', platformTime: 2 })
  })

  it('flattens rich text, with or without a locale wrapper', () => {
    expect(normalizeEvent(fixtures.post, bot)).toMatchObject({ text: 'Report\nsee link@Bob\n@user' })
    expect(normalizeEvent(fixtures.postPlain, bot)).toMatchObject({ text: 'flat' })
    const base = fixtures.postPlain as { event: { sender: unknown; message: object } }
    const noContent = {
      ...base,
      event: { sender: base.event.sender, message: { ...base.event.message, content: JSON.stringify({ unrelated: 1 }) } },
    }
    expect(normalizeEvent(noContent, bot)).toMatchObject({ text: '' })
  })

  it('turns images and files into attachment references', () => {
    expect(normalizeEvent(fixtures.image, bot)).toMatchObject({ text: '', attachments: [{ attachmentId: 'om_6:img_v2_abc:image', name: 'image' }] })
    expect(normalizeEvent(fixtures.file, bot)).toMatchObject({ attachments: [{ attachmentId: 'om_7:file_v2_abc:file', name: 'report.pdf' }] })
    const unnamed = normalizeEvent(fixtures.fileUnnamed, bot)
    expect(unnamed && 'attachments' in unnamed && unnamed.attachments).toEqual([{ attachmentId: 'om_7b:file_v2_abc:file' }])
  })

  it('flags app senders and tolerates unsupported or unreadable content', () => {
    expect(normalizeEvent(fixtures.fromApp, bot)).toMatchObject({ sender: { isBot: true } })
    expect(normalizeEvent(fixtures.sticker, bot)).toMatchObject({ text: '', attachments: [] })
    expect(normalizeEvent(fixtures.brokenContent, bot)).toMatchObject({ text: '' })
  })

  it('normalizes a card button press', () => {
    expect(normalizeEvent(fixtures.action, bot)).toEqual({
      type: 'interaction', interactionId: 'c-token', actionId: 'approve:k1', route: { kind: 'direct', chatId: 'oc_dm' }, sender: { userId: 'ou_alice', isBot: false },
    })
    expect(normalizeEvent(fixtures.actionNoToken, bot)).toMatchObject({ interactionId: 'om_card', actionId: 'reject:k1' })
  })

  it.each([
    fixtures.otherEvent, null, 'text', {}, { header: { event_type: 'im.message.receive_v1' }, event: {} },
    { header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_x' } }, message: { chat_id: 'oc', message_id: 1 } } },
    { header: { event_type: 'card.action.trigger' }, event: { operator: { open_id: 'ou_x' }, action: { value: {} }, context: { open_chat_id: 'oc' } } },
    { header: { event_type: 'card.action.trigger' }, event: { operator: {}, action: { value: { action: 'a' } }, context: {} } },
  ])('ignores %j', (event) => {
    expect(normalizeEvent(event, bot)).toBeUndefined()
  })

  it('names an unknown mention placeholder generically and gives a token-less press an empty id', () => {
    const event = { header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' }, message: { message_id: 'm', chat_id: 'c', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'hi @_user_9' }) } } }
    expect(normalizeEvent(event, bot)).toMatchObject({ text: 'hi @user', controlText: 'hi @user' })
    const press = { header: { event_type: 'card.action.trigger' }, event: { operator: { open_id: 'ou_x' }, action: { value: { action: 'a' } }, context: { open_chat_id: 'oc' } } }
    expect(normalizeEvent(press, bot)).toMatchObject({ interactionId: '' })
  })

  it('treats a message without content, and malformed post rows, as empty text', () => {
    const base = { header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' } } }
    const message = { message_id: 'm', chat_id: 'c', chat_type: 'p2p', message_type: 'text' }
    expect(normalizeEvent({ ...base, event: { ...base.event, message } }, bot)).toMatchObject({ text: '' })
    const post = { ...message, message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'text', text: 'ok' }], 'not a row'] }) }
    expect(normalizeEvent({ ...base, event: { ...base.event, message: post } }, bot)).toMatchObject({ text: 'ok\n' })
  })

  it('defaults a missing create time to zero', () => {
    const event = { header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' }, message: { message_id: 'm', chat_id: 'c', chat_type: 'p2p', message_type: 'text', content: '{"text":"x"}' } } }
    expect(normalizeEvent(event, bot)).toMatchObject({ platformTime: 0 })
  })
})

describe('parseAttachmentId', () => {
  it('splits a resource id and rejects malformed ones', () => {
    expect(parseAttachmentId('om_1:key:image')).toEqual({ messageId: 'om_1', key: 'key', type: 'image' })
    expect(parseAttachmentId('om_1:key:file')).toEqual({ messageId: 'om_1', key: 'key', type: 'file' })
    for (const bad of ['', 'a', 'a:b', 'a:b:video', 'a:b:image:c', ':b:image', 'a::image']) expect(parseAttachmentId(bad)).toBeUndefined()
  })
})
