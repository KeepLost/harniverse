import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginDiagnostics from '@deepseek-ai/dsh-plugin-diagnostics'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import { apply, inject } from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-agent-presets', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-agent-presets')>(),
  livePresetMounts: vi.fn(() => []),
}))

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; diagnostics: PluginDiagnostics }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginDiagnostics)
  await ctx.plugin({ inject: [...inject], apply })
  return { ctx, diagnostics: ctx.get('pluginDiagnostics') as PluginDiagnostics }
}

function fakeFiber(state: number, inject: readonly string[] = [], available: readonly string[] = []): Fiber {
  return {
    state,
    inject: Object.fromEntries(inject.map(service => [service, { required: true }])),
    ctx: { get: (service: string) => available.includes(service) ? {} : undefined },
  } as unknown as Fiber
}

describe('plugin diagnostics Cordis contribution', () => {
  it('reports missing Host dependencies but ignores active and disabled entries', async () => {
    const { ctx, diagnostics } = await harness()
    ctx.loader.builtins.active = () => {}
    ctx.loader.builtins.pending = { inject: ['zService', 'missingService'], apply() {} }
    await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    await ctx.loader.create({ name: 'cordis:disabled', disabled: true })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const report = await diagnostics.diagnose()
    expect(report.checksRun).toBe(3)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({
      checkId: 'cordis/host-loader',
      code: 'entry-pending',
      severity: 'error',
      domain: 'host-loader',
    })
    expect(report.findings[0]?.path).toContain(pendingId)
    expect(report.findings[0]?.message).toContain('missingService')
  })

  it('classifies every observable Host root state without treating active as health', async () => {
    const { ctx, diagnostics } = await harness()
    ctx.loader.builtins.fixture = () => {}
    const ids = await Promise.all([
      ctx.loader.create({ name: 'cordis:fixture' }),
      ctx.loader.create({ name: 'cordis:fixture' }),
      ctx.loader.create({ name: 'cordis:fixture' }),
      ctx.loader.create({ name: 'cordis:fixture' }),
      ctx.loader.create({ name: 'cordis:fixture' }),
      ctx.loader.create({ name: 'cordis:fixture' }),
    ])
    const entries = ids.map(id => [...ctx.loader.entries()].find(entry => entry.id === id)!)
    const fibers = entries.map(entry => entry.fiber!)
    Object.assign(fibers[0]!, { state: 0 })
    Object.assign(fibers[1]!, { state: 1 })
    Object.assign(fibers[2]!, { state: 3 })
    Object.assign(fibers[3]!, { state: 4 })
    Object.assign(fibers[4]!, { state: 5 })
    delete entries[5]!.fiber
    Object.assign(entries[5]!.options, { name: undefined })

    const report = await diagnostics.diagnose()
    expect(report.findings.map(finding => finding.code).sort()).toEqual([
      'entry-failed',
      'entry-not-started',
      'entry-pending',
      'entry-transitioning',
      'entry-transitioning',
    ])
    expect(report.findings.find(finding => finding.code === 'entry-pending')?.message)
      .toContain('without an observable missing service')
    expect(report.findings.find(finding => finding.code === 'entry-not-started')?.path).toBe(ids[5])

    for (const [index, entry] of entries.entries()) {
      entry.fiber = fibers[index]!
      Object.assign(entry.fiber, { state: 2 })
    }
  })

  it('classifies live standing preset roots when the optional owner is present', async () => {
    const { ctx, diagnostics } = await harness()
    ctx.provide('agentPresets', {} as never)
    vi.mocked(livePresetMounts).mockReturnValueOnce([
      { presetId: 'pending-missing', fiber: fakeFiber(0, ['database']) },
      { presetId: 'pending-ready', fiber: fakeFiber(0, ['database'], ['database']) },
      { presetId: 'failed', fiber: fakeFiber(3) },
      { presetId: 'loading', fiber: fakeFiber(1) },
      { presetId: 'unloading', fiber: fakeFiber(5) },
      { presetId: 'active', fiber: fakeFiber(2) },
      { presetId: 'disposed', fiber: fakeFiber(4) },
    ] as never)

    const findings = (await diagnostics.diagnose()).findings
      .filter(finding => finding.domain === 'standing-preset')
    expect(findings.map(finding => finding.code)).toEqual([
      'preset-mount-failed',
      'preset-mount-pending',
      'preset-mount-pending',
      'entry-transitioning',
      'entry-transitioning',
    ])
    expect(findings.some(finding => finding.message.includes('database'))).toBe(true)
    expect(findings.some(finding => finding.message.includes('without an observable missing service'))).toBe(true)
  })

  it('reports only sanitized failed and waiting dynamic attempts', async () => {
    const { ctx, diagnostics } = await harness()
    ctx.provide('dynamicCordisRunner', {
      inventory: () => [
        {
          pluginId: 'failed-plugin',
          agentId: 'agent',
          packages: [],
          latestRun: {
            pluginRunId: 'failed-run',
            packageId: 'failed-package',
            mode: 'run',
            status: 'failed',
            host: { status: 'failed', waitingFor: [], error: 'host secret' },
            client: { status: 'absent', waitingFor: [] },
            error: { phase: 'host-apply', message: 'credential=secret', stack: 'private stack' },
          },
        },
        {
          pluginId: 'failed-without-detail',
          agentId: 'agent',
          packages: [],
          latestRun: {
            pluginRunId: 'failed-without-detail-run',
            packageId: 'failed-without-detail-package',
            mode: 'run',
            status: 'failed',
            host: { status: 'failed', waitingFor: [] },
            client: { status: 'absent', waitingFor: [] },
          },
        },
        {
          pluginId: 'waiting-plugin',
          agentId: 'agent',
          packages: [],
          latestRun: {
            pluginRunId: 'waiting-run',
            packageId: 'waiting-package',
            mode: 'run',
            status: 'waiting',
            host: { status: 'waiting', waitingFor: ['tools'] },
            client: { status: 'waiting', waitingFor: ['slots'] },
          },
        },
        {
          pluginId: 'waiting-without-detail',
          agentId: 'agent',
          packages: [],
          latestRun: {
            pluginRunId: 'waiting-without-detail-run',
            packageId: 'waiting-without-detail-package',
            mode: 'run',
            status: 'waiting',
            host: { status: 'waiting', waitingFor: [] },
            client: { status: 'waiting', waitingFor: [] },
          },
        },
        {
          pluginId: 'stopped-plugin',
          agentId: 'agent',
          packages: [],
          latestRun: {
            pluginRunId: 'stopped-run',
            packageId: 'stopped-package',
            mode: 'run',
            status: 'stopped',
            host: { status: 'stopped', waitingFor: [] },
            client: { status: 'stopped', waitingFor: [] },
          },
        },
        { pluginId: 'never-run', agentId: 'agent', packages: [] },
      ],
    } as never)

    const report = await diagnostics.diagnose()
    expect(report.findings.map(finding => finding.code)).toEqual([
      'dynamic-run-failed',
      'dynamic-run-failed',
      'dynamic-run-waiting',
      'dynamic-run-waiting',
    ])
    expect(report.findings.some(finding => finding.message.includes('host-apply'))).toBe(true)
    expect(report.findings.some(finding => finding.message.includes('slots, tools'))).toBe(true)
    expect(report.findings.some(finding => finding.message.includes('without an observable missing service'))).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/credential=secret|private stack|host secret/)
  })

  it('removes every check with the contribution fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(PluginDiagnostics)
    const contribution = ctx.plugin({ inject: [...inject], apply })
    await contribution
    const diagnostics = ctx.get('pluginDiagnostics') as PluginDiagnostics
    expect((await diagnostics.diagnose()).checksRun).toBe(3)
    await contribution.dispose()
    expect((await diagnostics.diagnose()).checksRun).toBe(0)
  })

  it('returns an explicit disposer for direct composition owners', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(PluginDiagnostics)
    let dispose: (() => void) | undefined
    const owner = ctx.plugin(Object.assign(
      (inner: Context) => { dispose = apply(inner) },
      { inject: [...inject] },
    ))
    await owner
    const diagnostics = ctx.get('pluginDiagnostics') as PluginDiagnostics
    expect((await diagnostics.diagnose()).checksRun).toBe(3)
    dispose?.()
    expect((await diagnostics.diagnose()).checksRun).toBe(0)
    await owner.dispose()
  })
})
