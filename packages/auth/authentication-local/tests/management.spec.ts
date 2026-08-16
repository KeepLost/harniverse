import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addAuthenticationToken,
  deleteAuthenticationToken,
  listAuthenticationTokens,
  resetAuthenticationToken,
  verifyAuthenticationToken,
} from '../src/management.ts'

const homes: string[] = []

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-management-'))
  homes.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('named authentication token management', () => {
  it('adds a token, lists metadata without values, and verifies its bearer value', async () => {
    const dshHome = await home()
    const created = await addAuthenticationToken('laptop', { dshHome })

    expect(created.token).toMatch(/^dsh1_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/)
    expect(await verifyAuthenticationToken(created.token, { dshHome })).toMatchObject({ tokenName: 'laptop', generation: 1 })
    expect(await listAuthenticationTokens({ dshHome })).toEqual([{
      name: 'laptop',
      createdAt: created.createdAt,
    }])

    const document = await readFile(join(dshHome, 'auth', 'tokens.json'), 'utf8')
    expect(document).not.toContain(created.token)
    expect(document).not.toContain(created.token.split('_').at(-1))
  })

  it('rejects duplicate names without replacing the working token', async () => {
    const dshHome = await home()
    const created = await addAuthenticationToken('phone', { dshHome })
    await expect(addAuthenticationToken('phone', { dshHome })).rejects.toThrow(/already exists/)
    expect(await verifyAuthenticationToken(created.token, { dshHome })).toBeDefined()
  })

  it('resets only the named token and deletes only the named token', async () => {
    const dshHome = await home()
    const laptop = await addAuthenticationToken('laptop', { dshHome })
    const ci = await addAuthenticationToken('ci-runner', { dshHome })
    const rotated = await resetAuthenticationToken('laptop', { dshHome })

    expect(rotated.token.split('_')[1]).toBe(laptop.token.split('_')[1])
    expect(await verifyAuthenticationToken(laptop.token, { dshHome })).toBeUndefined()
    expect(await verifyAuthenticationToken(rotated.token, { dshHome })).toMatchObject({ tokenName: 'laptop', generation: 2 })
    expect(await verifyAuthenticationToken(ci.token, { dshHome })).toMatchObject({ tokenName: 'ci-runner' })

    await deleteAuthenticationToken('laptop', { dshHome })
    expect(await verifyAuthenticationToken(rotated.token, { dshHome })).toBeUndefined()
    expect(await verifyAuthenticationToken(ci.token, { dshHome })).toBeDefined()
  })

  it.skipIf(process.platform === 'win32')('rolls back a committed reset when its mandatory audit record fails', async () => {
    const dshHome = await home()
    const laptop = await addAuthenticationToken('laptop', { dshHome })
    await chmod(join(dshHome, 'auth', 'access.jsonl'), 0o644)

    await expect(resetAuthenticationToken('laptop', { dshHome })).rejects.toThrow(/accessible beyond its owner/)
    expect(await verifyAuthenticationToken(laptop.token, { dshHome })).toBeDefined()
  })

  it('requires an existing name for reset and delete', async () => {
    const dshHome = await home()
    await expect(resetAuthenticationToken('missing', { dshHome })).rejects.toThrow(/does not exist/)
    await expect(deleteAuthenticationToken('missing', { dshHome })).rejects.toThrow(/does not exist/)
  })
})
