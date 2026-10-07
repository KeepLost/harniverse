/** Recorded-shape Telegram updates (field subsets of real Bot API payloads). */

export const BOT = { id: '777000', username: 'HarniBot' }

const alice = { id: 42, is_bot: false, first_name: 'Alice', last_name: 'Liddell', username: 'alice' }
const privateChat = { id: 42, type: 'private', first_name: 'Alice' }
const group = { id: -100123, type: 'supergroup', title: 'Team' }

export const privateText = {
  update_id: 1001,
  message: { message_id: 5, from: alice, chat: privateChat, date: 1_700_000_000, text: 'hello there' },
}

export const groupMention = {
  update_id: 1002,
  message: {
    message_id: 6, from: alice, chat: group, date: 1_700_000_001, message_thread_id: 9,
    text: '@HarniBot summarize this', entities: [{ type: 'mention', offset: 0, length: 9 }],
  },
}

export const groupUnaddressed = {
  update_id: 1003,
  message: { message_id: 7, from: alice, chat: group, date: 1_700_000_002, text: 'just chatting' },
}

export const groupCommandForBot = {
  update_id: 1004,
  message: { message_id: 8, from: alice, chat: group, date: 1_700_000_003, text: '/status@harnibot now', entities: [{ type: 'bot_command', offset: 0, length: 16 }] },
}

export const groupCommandForOtherBot = {
  update_id: 1005,
  message: { message_id: 9, from: alice, chat: group, date: 1_700_000_004, text: '/status@OtherBot' },
}

export const groupBareCommand = {
  update_id: 1006,
  message: { message_id: 10, from: alice, chat: group, date: 1_700_000_005, text: '/help' },
}

export const replyToBot = {
  update_id: 1007,
  message: {
    message_id: 11, from: alice, chat: group, date: 1_700_000_006, text: 'and then?',
    reply_to_message: { message_id: 3, from: { id: 777000, is_bot: true, first_name: 'Harni' } },
  },
}

export const photoWithCaption = {
  update_id: 1008,
  message: {
    message_id: 12, from: alice, chat: privateChat, date: 1_700_000_007, caption: 'what is this?',
    photo: [{ file_id: 'small', file_size: 100 }, { file_id: 'large', file_size: 2_000, width: 800, height: 600 }],
  },
}

export const documentMessage = {
  update_id: 1009,
  message: {
    message_id: 13, from: alice, chat: privateChat, date: 1_700_000_008,
    document: { file_id: 'doc-1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 4_096 },
  },
}

export const editedMessage = {
  update_id: 1010,
  edited_message: { message_id: 5, from: alice, chat: privateChat, date: 1_700_000_000, text: 'hello again', edit_date: 1_700_000_100 },
}

export const callback = {
  update_id: 1011,
  callback_query: {
    id: 'cb-1', from: alice, chat_instance: 'x', data: 'approve:k1',
    message: { message_id: 20, chat: privateChat, date: 1_700_000_200, text: 'Approval needed' },
  },
}

export const groupCallbackInThread = {
  update_id: 1012,
  callback_query: {
    id: 'cb-2', from: alice, chat_instance: 'x', data: 'reject:k1',
    message: { message_id: 21, chat: group, message_thread_id: 9, date: 1_700_000_201 },
  },
}

export const channelPost = {
  update_id: 1013,
  channel_post: { message_id: 1, chat: { id: -1009, type: 'channel' }, date: 1, text: 'news' },
}

export const botSender = {
  update_id: 1014,
  message: { message_id: 14, from: { id: 999, is_bot: true, first_name: 'Other' }, chat: privateChat, date: 1_700_000_300, text: 'beep' },
}

export const nameless = {
  update_id: 1015,
  message: { message_id: 15, from: { id: 43, is_bot: false, username: 'anon' }, chat: { id: 43, type: 'private' }, date: 1_700_000_301, text: 'hi' },
}
