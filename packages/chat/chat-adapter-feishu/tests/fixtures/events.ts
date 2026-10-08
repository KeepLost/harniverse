/** Recorded-shape Feishu events (schema 2.0 subsets). */

export const BOT_OPEN_ID = 'ou_bot'

const user = { sender_id: { open_id: 'ou_alice', user_id: 'u1', union_id: 'on_1' }, sender_type: 'user', tenant_key: 't' }

function receive(message: Record<string, unknown>, sender: Record<string, unknown> = user): unknown {
  return { schema: '2.0', header: { event_id: 'e1', event_type: 'im.message.receive_v1', app_id: 'cli_a1b2c3d4e5f6a7b8' }, event: { sender, message } }
}

export const p2pText = receive({
  message_id: 'om_1', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '1700000000123', content: JSON.stringify({ text: 'hello there' }),
})

export const groupMention = receive({
  message_id: 'om_2', chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1700000001000',
  content: JSON.stringify({ text: '@_user_1 summarize this with @_user_2' }),
  mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Harni' }, { key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob' }],
})

export const groupPlain = receive({
  message_id: 'om_3', chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1', content: JSON.stringify({ text: 'just chatting' }),
})

export const groupReply = receive({
  message_id: 'om_4', chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '2', parent_id: 'om_0',
  content: JSON.stringify({ text: '@_user_1 and then?' }), mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Harni' }],
})

export const post = receive({
  message_id: 'om_5', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'post', create_time: '3',
  content: JSON.stringify({ zh_cn: { title: 'Report', content: [[{ tag: 'text', text: 'see ' }, { tag: 'a', text: 'link', href: 'https://x' }, { tag: 'at', user_name: 'Bob' }], [{ tag: 'at' }, { tag: 'img' }]] } }),
})

export const postPlain = receive({
  message_id: 'om_5b', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'post', create_time: '3',
  content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'flat' }]] }),
})

export const image = receive({
  message_id: 'om_6', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'image', create_time: '4', content: JSON.stringify({ image_key: 'img_v2_abc' }),
})

export const file = receive({
  message_id: 'om_7', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'file', create_time: '5', content: JSON.stringify({ file_key: 'file_v2_abc', file_name: 'report.pdf' }),
})

export const fileUnnamed = receive({
  message_id: 'om_7b', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'file', create_time: '5', content: JSON.stringify({ file_key: 'file_v2_abc' }),
})

export const sticker = receive({ message_id: 'om_8', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'sticker', create_time: '6', content: '{}' })

export const brokenContent = receive({ message_id: 'om_9', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '7', content: '{not json' })

export const fromApp = receive({ message_id: 'om_10', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', create_time: '8', content: JSON.stringify({ text: 'beep' }) }, { sender_id: { open_id: 'ou_app' }, sender_type: 'app' })

export const action = {
  schema: '2.0',
  header: { event_type: 'card.action.trigger' },
  event: { operator: { open_id: 'ou_alice' }, token: 'c-token', action: { tag: 'button', value: { action: 'approve:k1' } }, context: { open_message_id: 'om_card', open_chat_id: 'oc_dm' } },
}

export const actionNoToken = {
  schema: '2.0',
  header: { event_type: 'card.action.trigger' },
  event: { operator: { open_id: 'ou_alice' }, action: { value: { action: 'reject:k1' } }, context: { open_message_id: 'om_card', open_chat_id: 'oc_dm' } },
}

export const otherEvent = { schema: '2.0', header: { event_type: 'im.message.message_read_v1' }, event: {} }
