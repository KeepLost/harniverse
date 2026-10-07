/** The `ctx.chatBridge` owner-management surface: issuing owner codes, listing owners, and unpairing them. */

import { afterEach, describe, expect, it } from 'vitest'
import { boot, cleanup, readState } from './helpers.ts'

afterEach(cleanup)

const OWNER_CODE = /^[0-9A-Z]{5}-[0-9A-Z]{5}$/

describe('owner codes', () => {
  it('issues a one-time code that /pair redeems once and records the display name', async () => {
    const h = await boot({ owners: [] })
    const { code, expiresAt } = await h.ctx.chatBridge.issueOwnerCode()
    expect(code).toMatch(OWNER_CODE)
    expect(expiresAt).toBeGreaterThan(Date.now())
    await h.say('500', `/pair ${code}`, { displayName: 'Dana' })
    await h.say('501', `/pair ${code}`)
    expect(h.sent()).toEqual(['Paired as owner. Send /help for the commands.', 'That pairing code is not valid or has expired.'])
    expect(h.state().table('members').get('fake:500')).toMatchObject({ role: 'owner', displayName: 'Dana' })
    expect(h.state().table('members').get('fake:501')).toBeUndefined()
  })

  it('keeps the display name of a paired owner across a restart', async () => {
    const h = await boot({ owners: [] })
    const { code } = await h.ctx.chatBridge.issueOwnerCode()
    await h.say('500', `/pair ${code}`, { displayName: 'Dana' })
    await h.stopBridge()
    expect(await readState(h.root, state => state.table('members').get('fake:500'))).toMatchObject({ role: 'owner', displayName: 'Dana' })
  })

  it('expires after the configured owner code lifetime', async () => {
    const h = await boot({ config: { pairing: { ownerCodeTtlMs: 60_000 } } })
    const before = Date.now()
    const { expiresAt } = await h.ctx.chatBridge.issueOwnerCode()
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000)
  })

  it('stores only the hash of an issued code', async () => {
    const h = await boot()
    const { code, expiresAt } = await h.ctx.chatBridge.issueOwnerCode()
    const rows = [...h.state().table('codes').entries()]
    expect(rows).toHaveLength(1)
    expect(rows[0]![0]).not.toContain(code)
    expect(rows[0]![1]).toEqual({ kind: 'owner', expiresAt })
  })
})

describe('owners', () => {
  it('lists configured owners, then paired owners with their display names', async () => {
    const h = await boot({ owners: ['100'] })
    await h.state().table('members').put('fake:500', { role: 'owner', pairedAt: 10, displayName: 'Dana' })
    await h.state().table('members').put('fake:501', { role: 'owner', pairedAt: 20 })
    await h.state().table('members').put('fake:200', { role: 'member', memberId: 'alice', pairedAt: 30 })
    expect(h.ctx.chatBridge.owners()).toEqual([
      { key: 'fake:100', platform: 'fake', userId: '100', pairedAt: 0 },
      { key: 'fake:500', platform: 'fake', userId: '500', displayName: 'Dana', pairedAt: 10 },
      { key: 'fake:501', platform: 'fake', userId: '501', pairedAt: 20 },
    ])
  })

  it('lists an owner once when it is both configured and paired, and keeps colons in the user id', async () => {
    const h = await boot({ owners: ['100'] })
    await h.state().table('members').put('fake:100', { role: 'owner', pairedAt: 10 })
    await h.state().table('members').put('fake:a:b', { role: 'owner', pairedAt: 20 })
    expect(h.ctx.chatBridge.owners().map(owner => [owner.key, owner.userId])).toEqual([['fake:100', '100'], ['fake:a:b', 'a:b']])
  })

  it('lists nothing when no owner exists', async () => {
    const h = await boot({ owners: [] })
    expect(h.ctx.chatBridge.owners()).toEqual([])
  })
})

describe('unpairing owners', () => {
  it('removes a paired owner binding, after which the identity is a stranger', async () => {
    const h = await boot({ owners: [] })
    const { code } = await h.ctx.chatBridge.issueOwnerCode()
    await h.say('500', `/pair ${code}`)
    expect(await h.ctx.chatBridge.unpairOwner('fake:500')).toBe(true)
    expect(h.ctx.chatBridge.owners()).toEqual([])
    await h.say('500', '/help')
    expect(h.sent().at(-1)).toContain('Send /pair <code>')
  })

  it('refuses an unknown key, a member binding, and an owner from static configuration', async () => {
    const h = await boot({ owners: ['100'] })
    await h.state().table('members').put('fake:200', { role: 'member', memberId: 'alice', pairedAt: 1 })
    await h.state().table('members').put('fake:100', { role: 'owner', pairedAt: 1 })
    expect(await h.ctx.chatBridge.unpairOwner('fake:nobody')).toBe(false)
    expect(await h.ctx.chatBridge.unpairOwner('fake:200')).toBe(false)
    expect(await h.ctx.chatBridge.unpairOwner('fake:100')).toBe(false)
    expect(h.state().table('members').get('fake:200')).toMatchObject({ role: 'member' })
    expect(h.state().table('members').get('fake:100')).toMatchObject({ role: 'owner' })
  })
})

describe('service lifetime', () => {
  it('is removed together with the bridge scope', async () => {
    const h = await boot()
    expect(h.ctx.get('chatBridge')).toBeDefined()
    await h.stopBridge()
    expect(h.ctx.get('chatBridge')).toBeUndefined()
  })
})
