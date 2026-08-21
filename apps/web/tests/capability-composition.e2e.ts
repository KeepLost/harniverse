/** Real Web composition proof for Profile assembly generations. */

import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { CapabilityManagementGateway } from '@deepseek-ai/dsh-host-capability-management'
import type {} from '@deepseek-ai/dsh-tools'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('assembles a changed Profile only for new Sessions', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const capabilities = ctx.get('capabilityManagement') as CapabilityManagementGateway
  const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
  const existing = await ctx.agents.create({
    sessionId: SessionId('capability-composition-existing'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  let future: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  try {
    expect(ctx.tools.schemas(existing.agent).some(schema => schema.name === 'bash')).toBe(true)
    const existingRuntime = capabilities.session('capability-composition-existing')
    expect(existingRuntime).toMatchObject({
      agentProfile: 'standard',
      generation: 'standard@1',
    })
    expect(existingRuntime.entries).toContainEqual(expect.objectContaining({ id: 'plugin:tool-bash', status: 'loaded' }))
    const catalog = await capabilities.catalog(target)
    expect(catalog.entries).toContainEqual(expect.objectContaining({
      id: 'plugin:tool-bash',
      manageable: true,
      selected: true,
    }))

    const plan = await capabilities.plan(target, [
      { capabilityId: 'plugin:tool-bash', selection: 'unload' },
    ], catalog.revision)
    expect(plan.blockers).toEqual([])
    await capabilities.apply(plan.id, catalog.revision)

    expect(ctx.tools.schemas(existing.agent).some(schema => schema.name === 'bash')).toBe(true)
    future = await ctx.agents.create({
      sessionId: SessionId('capability-composition-future'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    expect(ctx.tools.schemas(future.agent).some(schema => schema.name === 'bash')).toBe(false)
    const futureRuntime = capabilities.session('capability-composition-future')
    expect(futureRuntime).toMatchObject({
      agentProfile: 'standard',
      generation: 'standard@2',
    })
    expect(futureRuntime.entries).toContainEqual(expect.objectContaining({ id: 'plugin:tool-bash', status: 'not-loaded' }))
  } finally {
    await future?.dispose()
    await existing.dispose()
  }
}, 120_000)
