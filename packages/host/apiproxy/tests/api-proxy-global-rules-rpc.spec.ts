/**
 * User-global-rules carrier paths of the host ApiProxy: `globalRules.read`
 * surfaces the service's file observation (existence, content, freshness
 * token, display path, cap) and `globalRules.write` maps the service's
 * outcomes onto the wire's stable error codes — seam absence, conflict with
 * the current token, the byte cap, and filesystem failures.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import GlobalRulesService from '@deepseek-ai/dsh-global-rules'
import type { GlobalRulesApi, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '../src/api-proxy.ts'

const scratchRoot = await mkdtemp(join(tmpdir(), 'dsh-global-rules-rpc-'))

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true })
})

async function scratchHome(name: string): Promise<string> {
  const home = join(scratchRoot, name)
  await mkdir(home, { recursive: true })
  return home
}

/** A context with the proxy's minimum service set plus the global-rules seam over a scratch home. */
async function harness(name: string, config: { maxSourceBytes?: number } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GlobalRulesService, { dshHome: await scratchHome(name), ...config })
  return ctx
}

/** A context with the proxy's minimum service set but no global-rules seam. */
async function bareHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** The composed proxy's globalRules face. */
function rulesFace(ctx: Context): GlobalRulesApi {
  const proxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  if (proxy.globalRules === undefined) throw new Error('composed proxy did not expose the globalRules face')
  return proxy.globalRules
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`global-rules-rpc-${String(nextRpc++)}`), payload }
}

describe('globalRules.read', () => {
  it('answers the absent file with existence, no token, and the cap', async () => {
    const ctx = await harness('absent', { maxSourceBytes: 9 })
    const response = await rulesFace(ctx).read(request({}))
    expect(response.result).toEqual({
      ok: true,
      value: { exists: false, content: '', displayPath: '$DSH_HOME/AGENTS.md', maxBytes: 9 },
    })
    await ctx.fiber.dispose()
  })

  it('answers the present file with content and its freshness token', async () => {
    const ctx = await harness('present')
    const face = rulesFace(ctx)
    await face.write(request({ content: '# rules' }))
    const response = await face.read(request({}))
    expect(response.result).toMatchObject({ ok: true, value: { exists: true, content: '# rules' } })
    await ctx.fiber.dispose()
  })

  it('maps seam absence and filesystem failure onto their codes', async () => {
    const bare = await bareHarness()
    const unavailable = await rulesFace(bare).read(request({}))
    expect(unavailable.result).toMatchObject({ ok: false, error: { code: 'global-rules-unavailable' } })
    await bare.fiber.dispose()

    const ctx = await harness('broken')
    await mkdir(join(scratchRoot, 'broken', 'AGENTS.md'))
    const failed = await rulesFace(ctx).read(request({}))
    expect(failed.result).toMatchObject({ ok: false, error: { code: 'global-rules-read-failed' } })
    await ctx.fiber.dispose()
  })
})

describe('globalRules.write', () => {
  it('persists content and answers the new freshness token', async () => {
    const ctx = await harness('write-ok')
    const face = rulesFace(ctx)
    const response = await face.write(request({ content: 'first' }))
    const read = await face.read(request({}))
    expect(response.result.ok).toBe(true)
    expect(read.result.ok).toBe(true)
    if (response.result.ok && read.result.ok) {
      expect(response.result.value.version).toBe(read.result.value.version)
      expect(response.result.value.version).toMatch(/^[0-9a-f]{32}$/)
    }
    await ctx.fiber.dispose()
  })

  it('maps seam absence, conflict, and the byte cap onto their codes', async () => {
    const bare = await bareHarness()
    const unavailable = await rulesFace(bare).write(request({ content: 'x' }))
    expect(unavailable.result).toMatchObject({ ok: false, error: { code: 'global-rules-unavailable' } })
    await bare.fiber.dispose()

    const ctx = await harness('outcomes', { maxSourceBytes: 1024 })
    const face = rulesFace(ctx)
    const first = await face.write(request({ content: 'mine' }))
    const firstVersion = first.result.ok ? first.result.value.version : undefined
    await face.write(request({ content: 'external' }))
    const conflict = await face.write(request({
      content: 'clobber',
      ...(firstVersion === undefined ? {} : { expectedVersion: firstVersion }),
    }))
    expect(conflict.result).toMatchObject({
      ok: false,
      error: { code: 'global-rules-conflict' },
    })
    if (!conflict.result.ok && 'version' in conflict.result.error.details) {
      expect(conflict.result.error.details.version).toBeTypeOf('string')
    }

    const tooLarge = await face.write(request({ content: 'x'.repeat(1025) }))
    expect(tooLarge.result).toMatchObject({
      ok: false,
      error: { code: 'global-rules-too-large', details: { maxBytes: 1024 } },
    })
    await ctx.fiber.dispose()
  })

  it('maps a filesystem write failure onto its code', async () => {
    const ctx = await harness('write-broken')
    await mkdir(join(scratchRoot, 'write-broken', 'AGENTS.md'))
    const failed = await rulesFace(ctx).write(request({ content: 'nope' }))
    expect(failed.result).toMatchObject({ ok: false, error: { code: 'global-rules-write-failed' } })
    await ctx.fiber.dispose()
  })
})
