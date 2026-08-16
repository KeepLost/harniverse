import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAuthToken } from '../src/auth.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-cli-auth-'))
  homes.push(value)
  return value
}

function output(): { text: string; write(value: string): void } {
  return {
    text: '',
    write(value) { this.text += value },
  }
}

describe('authentication token CLI', () => {
  it('prints generated values once while list exposes metadata only', async () => {
    const dshHome = await home()
    const addOut = output()
    await runAuthToken({ mode: 'auth-token', operation: 'add', name: 'laptop' }, { dshHome, stdout: addOut })
    const first = addOut.text.trim()
    expect(first).toMatch(/^dsh1_/)
    expect(addOut.text.match(/dsh1_/g)).toHaveLength(1)

    const listOut = output()
    await runAuthToken({ mode: 'auth-token', operation: 'list' }, { dshHome, stdout: listOut })
    expect(listOut.text).toContain('laptop')
    expect(listOut.text).not.toContain(first)

    const resetOut = output()
    await runAuthToken({ mode: 'auth-token', operation: 'reset', name: 'laptop' }, { dshHome, stdout: resetOut })
    expect(resetOut.text.trim()).toMatch(/^dsh1_/)
    expect(resetOut.text.trim()).not.toBe(first)

    const deleteOut = output()
    await runAuthToken({ mode: 'auth-token', operation: 'delete', name: 'laptop' }, { dshHome, stdout: deleteOut })
    expect(deleteOut.text).toBe('')
  })
})
