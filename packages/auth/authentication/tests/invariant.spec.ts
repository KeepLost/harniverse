import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AuthenticationInvariant from '../src/invariant.ts'
import { authenticationGrantId } from '../src/index.ts'
import type { AuthenticationRevocation } from '../src/index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-authentication'

const revocation: AuthenticationRevocation = {
  grants: [{ grantId: authenticationGrantId('grant-1'), grantRevision: 1 }],
}

describe('authentication invariant companion', () => {
  it('accepts a revocation emitted by a live authentication service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AuthenticationInvariant)
    ctx.provide('authentication', {})

    expect(() => { ctx.emit('authentication/revoked', revocation) }).not.toThrow()
  })

  it('fails a revocation emitted without a live authentication service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AuthenticationInvariant)

    expect(() => { ctx.emit('authentication/revoked', revocation) })
      .toThrow(/invariant violated by "@deepseek-ai\/dsh-authentication"/)
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AuthenticationInvariant)

    expect(() => {
      ctx.invariants.register(PACKAGE_NAME, () => {})
    }).toThrow(/already registered/)
  })
})
