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
    const existingRuntime = await capabilities.session('capability-composition-existing')
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
    const cordisCatalog = await capabilities.catalog({ kind: 'agent-profile', agentProfile: 'cordis' })
    expect(cordisCatalog.entries.find(entry => entry.id === 'plugin:skill-filesystem')?.memberEntries)
      .toContainEqual(expect.objectContaining({ name: 'editing-cordis-compositions', visible: true }))

    const filesystem = catalog.entries.find(entry => entry.id === 'plugin:tool-fs')!
    const visibleFilesystemMembers = filesystem.memberEntries
      ?.filter(member => member.name !== 'write')
      .map(member => member.id) ?? []
    const plan = await capabilities.plan(target, [
      { capabilityId: 'plugin:tool-bash', selection: 'unload' },
      { capabilityId: 'plugin:tool-fs', members: visibleFilesystemMembers },
      { capabilityId: 'plugin:persona', config: { text: 'You are the customized generation.' } },
    ], catalog.revision)
    expect(plan.blockers).toEqual([])
    await capabilities.apply(plan.id, catalog.revision)

    expect(ctx.tools.schemas(existing.agent).some(schema => schema.name === 'bash')).toBe(true)
    expect(ctx.tools.schemas(existing.agent).some(schema => schema.name === 'write')).toBe(true)
    future = await ctx.agents.create({
      sessionId: SessionId('capability-composition-future'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    expect(ctx.tools.schemas(future.agent).some(schema => schema.name === 'bash')).toBe(false)
    expect(ctx.tools.schemas(future.agent).some(schema => schema.name === 'read')).toBe(true)
    expect(ctx.tools.schemas(future.agent).some(schema => schema.name === 'write')).toBe(false)
    const existingPrompt = (await ctx.systemPrompt.assemble({ scope: existing.agent })).sections.map(section => section.text).join('\n')
    const futurePrompt = (await ctx.systemPrompt.assemble({ scope: future.agent })).sections.map(section => section.text).join('\n')
    expect(existingPrompt).not.toContain('customized generation')
    expect(futurePrompt).toContain('customized generation')
    const futureRuntime = await capabilities.session('capability-composition-future')
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

it('keeps standard native and code presentation explicitly Profile-scoped', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const standard = await ctx.agents.create({
    sessionId: SessionId('capability-composition-standard-native'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  const code = await ctx.agents.create({
    sessionId: SessionId('capability-composition-code-presentation'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'code').then(() => undefined),
  })
  try {
    const standardPrompt = await ctx.systemPrompt.assemble({ scope: standard.agent })
    const codePrompt = await ctx.systemPrompt.assemble({ scope: code.agent })
    expect(standardPrompt.tools.some(schema => schema.name === 'read')).toBe(true)
    expect(standardPrompt.tools.some(schema => schema.name === 'run_code')).toBe(false)
    expect(codePrompt.tools.map(schema => schema.name)).toEqual(['run_code'])
  } finally {
    await code.dispose()
    await standard.dispose()
  }
}, 120_000)
