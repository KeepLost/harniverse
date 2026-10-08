import { describe, expect, it } from 'vitest'
import { readSecrets, removeSecrets, secretRef, secretRefs, secretView, storeSecrets } from '../src/secrets.ts'
import { MemoryCredentials } from './fixtures/credentials.ts'

describe('secret credentials', () => {
  it('names one upper-case credential per bot and field', () => {
    expect(secretRef('bot_ab12cd34', 'token')).toBe('DSH_CHAT_BOT_BOT_AB12CD34_TOKEN')
    expect(secretRef('bot_ab12cd34', 'appSecret')).toBe('DSH_CHAT_BOT_BOT_AB12CD34_APPSECRET')
    expect(secretRefs('bot_ab12cd34', ['token', 'appSecret'])).toEqual({
      token: 'DSH_CHAT_BOT_BOT_AB12CD34_TOKEN',
      appSecret: 'DSH_CHAT_BOT_BOT_AB12CD34_APPSECRET',
    })
  })

  it('stores, reads, and removes a bot\'s secrets', async () => {
    const store = new MemoryCredentials()
    await storeSecrets(store.asProvider(), 'bot_00000001', { token: 'T-1', appSecret: 'S-1' })
    expect(await readSecrets(store.asProvider(), 'bot_00000001', ['token', 'appSecret', 'missing'])).toEqual({ token: 'T-1', appSecret: 'S-1' })
    await removeSecrets(store.asProvider(), 'bot_00000001', ['token', 'appSecret'])
    expect([...store.values.keys()]).toEqual([])
    await removeSecrets(store.asProvider(), 'bot_00000001', ['token'])
  })

  it('stores all or nothing: a failed write unsets the ones already stored and rethrows', async () => {
    const store = new MemoryCredentials()
    store.failSet = 'DSH_CHAT_BOT_BOT_00000002_APPSECRET'
    await expect(storeSecrets(store.asProvider(), 'bot_00000002', { token: 'T-2', appSecret: 'S-2' })).rejects.toThrow('cannot store')
    expect([...store.values.keys()]).toEqual([])
    expect(store.calls).toEqual([
      'set DSH_CHAT_BOT_BOT_00000002_TOKEN',
      'set DSH_CHAT_BOT_BOT_00000002_APPSECRET',
      'unset DSH_CHAT_BOT_BOT_00000002_TOKEN',
    ])
  })

  it('shows a tail only for a secret long enough that four characters stay a small share', () => {
    expect(secretView(undefined)).toEqual({ configured: false, tail: '' })
    expect(secretView('short-secret')).toEqual({ configured: true, tail: '' })
    expect(secretView('0123456789abcdef')).toEqual({ configured: true, tail: 'cdef' })
    expect(secretView(`123456789:${'x'.repeat(31)}Dsaw`)).toEqual({ configured: true, tail: 'Dsaw' })
  })
})
