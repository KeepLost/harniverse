import { describe, expect, it, vi } from 'vitest'
import { CRASH_REPORT_WAIT_MS, DesktopFatalRecovery, type RecoveryOperations } from '../src/fatal-recovery.ts'
import { shellCopy } from '../src/locale.ts'

interface Fixture {
  recovery: DesktopFatalRecovery
  operations: {
    shown: Array<Record<string, unknown>>
    show: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    exit: ReturnType<typeof vi.fn>
    restart: ReturnType<typeof vi.fn>
    writeReport: ReturnType<typeof vi.fn>
  }
}

function fixture(reportPath: string | undefined = '/logs/crash-x.log', reportError: unknown = undefined): Fixture {
  const shown: Array<Record<string, unknown>> = []
  const operations = {
    shown,
    show: vi.fn(async (options: Record<string, unknown>) => { shown.push(options); return { response: 0 } }),
    stop: vi.fn(async () => {}),
    exit: vi.fn(),
    restart: vi.fn(),
    writeReport: vi.fn(async () => {
      if (reportError !== undefined) throw reportError
      return reportPath
    }),
  }
  const recovery = new DesktopFatalRecovery({
    messages: () => shellCopy('en-US'),
    show: operations.show,
    stop: operations.stop,
    exit: operations.exit,
    restart: operations.restart,
    writeReport: operations.writeReport,
  } as RecoveryOperations)
  return { recovery, operations }
}

describe('DesktopFatalRecovery', () => {
  it('persists the report before the dialog and names it in the detail', async () => {
    const { recovery, operations } = await fixture('/logs/crash-host.log') as Fixture
    await recovery.report(new Error('fatal failure'), 'host')
    expect(operations.shown).toHaveLength(1)
    // The report is persisted before the dialog so the dialog can name the file.
    expect(operations.writeReport.mock.invocationCallOrder[0]).toBeLessThan(operations.show.mock.invocationCallOrder[0]!)
    const dialog = operations.shown[0]!
    expect(dialog.title).toBe('Harniverse failed to start')
    expect(dialog.message).toBe('Harniverse hit a fatal error.')
    expect(dialog.buttons).toEqual(['Exit', 'Restart'])
    expect(dialog.defaultId).toBe(1)
    expect(dialog.cancelId).toBe(0)
    expect(dialog.noLink).toBe(true)
    expect(String(dialog.detail)).toContain('fatal failure')
    expect(String(dialog.detail)).toContain('Crash report written to: /logs/crash-host.log')
    expect(String(dialog.detail)).toContain('reinstall the application')
    expect(operations.exit).toHaveBeenCalled()
    expect(operations.stop).toHaveBeenCalled()
    expect(operations.restart).not.toHaveBeenCalled()
  })

  it('shortens a long diagnostic to the tail with the truncation notice', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n')
    const { recovery, operations } = fixture()
    await recovery.report(new Error(lines), 'host')
    const detail = String(operations.shown[0]!.detail)
    expect(detail).toContain('diagnostic shortened')
    expect(detail).toContain('line 39')
    expect(detail).not.toContain('line 5\n')
  })

  it('shows a whole short error without the truncation notice', async () => {
    const { recovery, operations } = fixture()
    await recovery.report(new Error('short'), 'host')
    expect(String(operations.shown[0]!.detail)).not.toContain('diagnostic shortened')
  })

  it('strips a leading lone surrogate left by the tail cut', async () => {
    const { recovery, operations } = fixture()
    await recovery.report(new Error('\uDC00surrogate tail'), 'host')
    expect(String(operations.shown[0]!.detail)).not.toMatch(/^[\uDC00-\uDFFF]/u)
  })

  it('special-cases a bound local Host port with the report line intact', async () => {
    const { recovery, operations } = fixture('/logs/crash-host.log')
    await recovery.report(new Error('listen EADDRINUSE: address already in use'), 'host')
    const detail = String(operations.shown[0]!.detail)
    expect(detail).toContain('port is already in use')
    expect(detail).toContain('Crash report written to: /logs/crash-host.log')
    expect(detail).not.toContain('diagnostic shortened')
  })

  it('restarts through stop after the restart choice, retrying the dialog when stop fails', async () => {
    const { recovery, operations } = fixture()
    const respondRestart = (): void => {
      operations.show.mockImplementationOnce(async (options: Record<string, unknown>) => {
        operations.shown.push(options)
        return { response: 1 }
      })
    }
    respondRestart()
    respondRestart()
    operations.stop.mockRejectedValueOnce(new Error('stop refused'))
    const reported = recovery.report(new Error('fatal failure'), 'host')
    await vi.waitFor(() => { expect(operations.shown).toHaveLength(2) })
    expect(String(operations.shown[1]!.message)).toContain('recovery operation failed')
    expect(String(operations.shown[1]!.detail)).toContain('stop refused')
    await reported
    expect(operations.restart).toHaveBeenCalled()
    expect(operations.exit).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error failure for the dialog detail', async () => {
    const { recovery, operations } = fixture()
    await recovery.report('plain fatal string', 'main')
    expect(String(operations.shown[0]!.detail)).toContain('plain fatal string')
  })

  it('still exits when stopping fails on the exit choice', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { recovery, operations } = fixture()
    operations.stop.mockRejectedValue(new Error('stop refused'))
    await recovery.report(new Error('fatal failure'), 'host')
    expect(operations.exit).toHaveBeenCalled()
    expect(operations.restart).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
  })

  it('resolves duplicate reports immediately without another dialog', async () => {
    const { recovery, operations } = fixture()
    operations.show.mockImplementation(async (options: Record<string, unknown>) => {
      operations.shown.push(options)
      return new Promise<never>(() => {})
    })
    const first = recovery.report(new Error('first'), 'host')
    await vi.waitFor(() => { expect(operations.shown).toHaveLength(1) })
    await expect(recovery.report(new Error('second'), 'renderer')).resolves.toBeUndefined()
    expect(operations.shown).toHaveLength(1)
    expect(recovery.active).toBe(true)
    void first
  })

  it('opens the dialog without a path when the report write is slow', async () => {
    vi.useFakeTimers()
    try {
      const operations = {
        show: vi.fn(async () => ({ response: 0 })),
        stop: vi.fn(async () => {}),
        exit: vi.fn(),
        restart: vi.fn(),
        writeReport: () => new Promise<string | undefined>(() => {}),
      }
      const recovery = new DesktopFatalRecovery({
        messages: () => shellCopy('en-US'), ...operations,
      } as RecoveryOperations)
      const reported = recovery.report(new Error('fatal failure'), 'host')
      await vi.advanceTimersByTimeAsync(CRASH_REPORT_WAIT_MS)
      await reported
      expect(operations.show).toHaveBeenCalled()
      expect(String(operations.show.mock.calls[0]![0].detail)).not.toContain('Crash report written to:')
      expect(operations.exit).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the dialog when the report write rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { recovery, operations } = fixture(undefined, new Error('disk full'))
    await recovery.report(new Error('fatal failure'), 'host')
    expect(operations.show).toHaveBeenCalled()
    expect(String(operations.shown[0]!.detail)).not.toContain('Crash report written to:')
    expect(consoleError).toHaveBeenCalled()
  })
})
