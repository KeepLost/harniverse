/** The client plugin registers its dictionaries and the sent-user-text rule. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SentUserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as plugin from '../src/client/index.ts'
import * as hostPlugin from '../src/index.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('ui-secret-mask client plugin', () => {
  it('registers the dictionaries and the rule, and disposes both with the context', async () => {
    const ctx = new Context()
    roots.push(ctx)
    ctx.provide('locale')
    const dictionaries = new Map<string, Record<string, string>>()
    ctx.set('locale', {
      register: (ns: string, dicts: Record<string, string>) => {
        dictionaries.set(ns, dicts)
        return () => { dictionaries.delete(ns) }
      },
      bind: (ns: string) => (key: string) => dictionaries.get(ns)?.[key] ?? key,
    } as never)
    // The conversation service face the plugin registers through; a local
    // registry stands in for the seam so the spec owns its own state.
    const rules: SentUserTextRule[] = []
    ctx.provide('conversation')
    ctx.set('conversation', {
      sentUserText: { register: (rule: SentUserTextRule) => { rules.push(rule); return () => { rules.splice(rules.indexOf(rule), 1) } } },
    } as never)

    expect(rules.map(rule => rule.id)).not.toContain('secret')
    const fiber = ctx.plugin(plugin)
    await fiber.await()

    expect(dictionaries.get('secretMask')).toMatchObject({ zh: { 'secret.reveal': '显示密钥', 'secret.hide': '隐藏密钥' } })
    expect(rules.map(rule => rule.id)).toContain('secret')

    await fiber.dispose()
    expect(rules.map(rule => rule.id)).not.toContain('secret')
    expect(dictionaries.has('secretMask')).toBe(false)
  })
})

describe('ui-secret-mask host plugin', () => {
  it('is a display-only plugin whose host body is a no-op', () => {
    expect(() => { hostPlugin.apply() }).not.toThrow()
  })
})
