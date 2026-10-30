/** The client plugin registers its sent-user-text rule. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SentUserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as plugin from '../src/client/index.ts'
import * as hostPlugin from '../src/index.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('ui-message-quotes client plugin', () => {
  it('registers the rule, and disposes it with the context', async () => {
    const ctx = new Context()
    roots.push(ctx)
    // The conversation service face the plugin registers through; a local
    // registry stands in for the seam so the spec owns its own state.
    const rules: SentUserTextRule[] = []
    ctx.provide('conversation')
    ctx.set('conversation', {
      sentUserText: { register: (rule: SentUserTextRule) => { rules.push(rule); return () => { rules.splice(rules.indexOf(rule), 1) } } },
    } as never)

    expect(rules.map(rule => rule.id)).not.toContain('quote')
    const fiber = ctx.plugin(plugin)
    await fiber.await()

    expect(rules.map(rule => rule.id)).toContain('quote')

    await fiber.dispose()
    expect(rules.map(rule => rule.id)).not.toContain('quote')
  })
})

describe('ui-message-quotes host plugin', () => {
  it('is a display-only plugin whose host body is a no-op', () => {
    expect(() => { hostPlugin.apply() }).not.toThrow()
  })
})
