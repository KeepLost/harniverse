import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PluginDiagnostics from '../src/index.ts'
import type { PluginDiagnosticCheck } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; diagnostics: PluginDiagnostics }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(PluginDiagnostics)
  return { ctx, diagnostics: ctx.get('pluginDiagnostics') as PluginDiagnostics }
}

function check(id: string, diagnose: PluginDiagnosticCheck['diagnose']): PluginDiagnosticCheck {
  return { id, description: `${id} description`, diagnose }
}

describe('PluginDiagnostics', () => {
  it('validates registrations and rejects duplicate stable ids', async () => {
    const { diagnostics } = await harness()
    expect(() => diagnostics.register(check('Bad ID', () => []))).toThrow('stable lowercase id')
    expect(() => diagnostics.register({ id: 'empty/description', description: '', diagnose: () => [] }))
      .toThrow('description must be non-blank')
    expect(() => diagnostics.register({ id: 'valid/check', description: ' ', diagnose: () => [] }))
      .toThrow('description must be non-blank')
    diagnostics.register(check('valid/check', () => []))
    expect(() => diagnostics.register(check('valid/check', () => []))).toThrow('already registered')
  })

  it('sorts copied findings and contains one failing check without leaking its error', async () => {
    const { diagnostics } = await harness()
    diagnostics.register(check('z/check', () => [{
      checkId: 'z/check',
      code: 'warning-code',
      severity: 'warning',
      domain: 'host-loader',
      message: 'warning',
      path: 'z',
    }]))
    diagnostics.register(check('a/check', () => [{
      checkId: 'a/check',
      code: 'error-code',
      severity: 'error',
      domain: 'standing-preset',
      message: 'error',
      path: 'a',
    }]))
    diagnostics.register(check('broken/check', () => { throw new Error('credential=secret') }))

    const report = await diagnostics.diagnose()
    expect(report.checksRun).toBe(3)
    expect(report.observedAt).toEqual(expect.any(Number))
    expect(report.findings.map(finding => `${finding.severity}:${finding.checkId}`)).toEqual([
      'error:a/check',
      'error:broken/check',
      'warning:z/check',
    ])
    expect(JSON.stringify(report)).not.toContain('credential=secret')
    expect(report.findings[1]).toMatchObject({
      code: 'check-failed',
      domain: 'diagnostic-check',
    })
  })

  it('binds registrations to the caller fiber and honors cancellation', async () => {
    const { ctx, diagnostics } = await harness()
    const contribution = ctx.plugin(Object.assign(
      (childCtx: Context) => childCtx.pluginDiagnostics.register(check('owned/check', () => [])),
      { inject: ['pluginDiagnostics'] },
    ))
    await contribution
    expect((await diagnostics.diagnose()).checksRun).toBe(1)
    await contribution.dispose()
    expect((await diagnostics.diagnose()).checksRun).toBe(0)

    diagnostics.register(check('never/run', () => { throw new Error('should not run') }))
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(diagnostics.diagnose(controller.signal)).rejects.toThrow('cancelled')
  })

  it('rejects findings that impersonate another check or use an invalid code', async () => {
    const { diagnostics } = await harness()
    diagnostics.register(check('owner/check', () => [{
      checkId: 'other/check',
      code: 'Bad Code',
      severity: 'info',
      domain: 'diagnostic-check',
      message: 'invalid',
    }]))
    const report = await diagnostics.diagnose()
    expect(report.findings).toEqual([expect.objectContaining({
      checkId: 'owner/check',
      code: 'check-failed',
    })])

    const { diagnostics: invalidCode } = await harness()
    invalidCode.register(check('owner/code', () => [{
      checkId: 'owner/code',
      code: 'Bad Code',
      severity: 'info',
      domain: 'diagnostic-check',
      message: 'invalid code',
    }]))
    expect((await invalidCode.diagnose()).findings[0]?.code).toBe('check-failed')

    const { diagnostics: emptyMessage } = await harness()
    emptyMessage.register(check('owner/message', () => [{
      checkId: 'owner/message',
      code: 'invalid-message',
      severity: 'info',
      domain: 'diagnostic-check',
      message: '',
    }]))
    expect((await emptyMessage.diagnose()).findings[0]?.code).toBe('check-failed')

    const { diagnostics: paddedMessage } = await harness()
    paddedMessage.register(check('owner/padded', () => [{
      checkId: 'owner/padded',
      code: 'invalid-message',
      severity: 'info',
      domain: 'diagnostic-check',
      message: ' padded ',
    }]))
    expect((await paddedMessage.diagnose()).findings[0]?.code).toBe('check-failed')
  })

  it('orders equal-severity findings by check, path, and code', async () => {
    const { diagnostics } = await harness()
    diagnostics.register(check('same/check', () => [{
      checkId: 'same/check', code: 'z-code', severity: 'info', domain: 'diagnostic-check', message: 'z', path: 'same',
    }, {
      checkId: 'same/check', code: 'a-code', severity: 'info', domain: 'diagnostic-check', message: 'a', path: 'same',
      fixHint: 'Inspect a.',
    }, {
      checkId: 'same/check', code: 'other-path', severity: 'info', domain: 'diagnostic-check', message: 'path', path: 'first',
    }, {
      checkId: 'same/check', code: 'no-path', severity: 'info', domain: 'diagnostic-check', message: 'none',
    }, {
      checkId: 'same/check', code: 'no-path-z', severity: 'info', domain: 'diagnostic-check', message: 'none z',
    }]))
    diagnostics.register(check('later/check', () => [{
      checkId: 'later/check', code: 'only', severity: 'info', domain: 'diagnostic-check', message: 'later',
    }]))

    expect((await diagnostics.diagnose()).findings.map(finding => finding.code)).toEqual([
      'only',
      'no-path',
      'no-path-z',
      'other-path',
      'a-code',
      'z-code',
    ])
  })
})
