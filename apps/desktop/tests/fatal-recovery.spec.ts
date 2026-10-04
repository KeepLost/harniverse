import { describe, expect, it, vi } from 'vitest'
import { CRASH_REPORT_WAIT_MS, DesktopFatalRecovery } from '../src/fatal-recovery.ts'
import type { CrashReportSource } from '../src/crash-report.ts'
import { shellCopy } from '../src/locale.ts'

interface Fixture {
  recovery: DesktopFatalRecovery
  shown: Array<Record<string, unknown>>
  show: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
  writeReport: ReturnType<typeof vi.fn>
}

function fixture(options: {
  reportPath?: string
  reportError?: unknown
  responses?: number[]
  hangFirstDialog?: boolean
} = {}): Fixture {
  const responses = [...(options.responses ?? [0])]
  const shown: Array<Record<string, unknown>> = []
  const show = vi.fn(async (dialogOptions: Record<string, unknown>): Promise<{ response: number }> => {
    shown.push(dialogOptions)
    if (options.hangFirstDialog === true && shown.length === 1) return new Promise<never>(() => {})
    return { response: responses.length > 0 ? responses.shift() ?? 0 : 0 }
  })
  const stop = vi.fn(async () => {})
  const exit = vi.fn()
  const restart = vi.fn()
  const writeReport = vi.fn(async (_error: unknown, _source: CrashReportSource): Promise<string | undefined> => {
    if (options.reportError !== undefined) throw options.reportError
    return options.reportPath ?? '/logs/crash-x.log'
  })
  const recovery = new DesktopFatalRecovery({
    messages: () => shellCopy('en-US'),
    show: options => show(options),
    stop: () => stop(),
    exit: () => { exit() },
    restart: () => { restart() },
    writeReport: (error, source) => writeReport(error, source),
  })
  return { recovery, shown, show, stop, exit, restart, writeReport }
}

describe('DesktopFatalRecovery', () => {
  it('persists the report before the dialog and names it in the detail', async () => {
    const { recovery, shown, show, writeReport, stop, exit, restart } = fixture({ reportPath: '/logs/crash-host.log' })
    await recovery.report(new Error('fatal failure'), 'host')
    // The report is persisted before the dialog so the dialog can name the file.
    expect(writeReport.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0])
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Harniverse failed to start')
    expect(shown[0].message).toBe('Harniverse hit a fatal error.')
    expect(shown[0].buttons).toEqual(['Exit', 'Restart'])
    expect(shown[0].defaultId).toBe(1)
    expect(shown[0].cancelId).toBe(0)
    expect(shown[0].noLink).toBe(true)
    expect(String(shown[0].detail)).toContain('fatal failure')
    expect(String(shown[0].detail)).toContain('Crash report written to: /logs/crash-host.log')
    expect(String(shown[0].detail)).toContain('reinstall the application')
    expect(exit).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('shortens a long diagnostic to the tail with the truncation notice', async () => {
    const { recovery, shown } = fixture()
    const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n')
    await recovery.report(new Error(lines), 'host')
    const detail = String(shown[0].detail)
    expect(detail).toContain('diagnostic shortened')
    expect(detail).toContain('line 39')
    expect(detail).not.toContain('line 5\n')
  })

  it('shows a whole short error without the truncation notice', async () => {
    const { recovery, shown } = fixture()
    await recovery.report(new Error('short'), 'host')
    expect(String(shown[0].detail)).not.toContain('diagnostic shortened')
  })

  it('strips a leading lone surrogate left by the tail cut', async () => {
    const { recovery, shown } = fixture()
    await recovery.report(new Error('\uDC00surrogate tail'), 'host')
    expect(String(shown[0].detail)).not.toMatch(/^[\uDC00-\uDFFF]/u)
  })

  it('special-cases a bound local Host port with the report line intact', async () => {
    const { recovery, shown } = fixture({ reportPath: '/logs/crash-host.log' })
    await recovery.report(new Error('listen EADDRINUSE: address already in use'), 'host')
    const detail = String(shown[0].detail)
    expect(detail).toContain('port is already in use')
    expect(detail).toContain('Crash report written to: /logs/crash-host.log')
    expect(detail).not.toContain('diagnostic shortened')
  })

  it('restarts through stop after the restart choice, retrying the dialog when stop fails', async () => {
    const { recovery, shown, stop, restart, exit } = fixture({ responses: [1, 1] })
    stop.mockRejectedValueOnce(new Error('stop refused'))
    const reported = recovery.report(new Error('fatal failure'), 'host')
    await vi.waitFor(() => { expect(shown).toHaveLength(2) })
    expect(String(shown[1].message)).toContain('recovery operation failed')
    expect(String(shown[1].detail)).toContain('stop refused')
    await reported
    expect(restart).toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('resolves duplicate reports immediately without another dialog', async () => {
    const { recovery, shown } = fixture({ hangFirstDialog: true })
    const first = recovery.report(new Error('first'), 'host')
    await vi.waitFor(() => { expect(shown).toHaveLength(1) })
    await expect(recovery.report(new Error('second'), 'renderer')).resolves.toBeUndefined()
    expect(shown).toHaveLength(1)
    expect(recovery.active).toBe(true)
    void first
  })

  it('opens the dialog without a path when the report write is slow', async () => {
    vi.useFakeTimers()
    try {
      const shown: Array<Record<string, unknown>> = []
      const show = vi.fn(async (options: Record<string, unknown>) => { shown.push(options); return { response: 0 } })
      const stop = vi.fn(async () => {})
      const exit = vi.fn()
      const recovery = new DesktopFatalRecovery({
        messages: () => shellCopy('en-US'),
        show: options => show(options),
        stop: () => stop(),
        exit: () => { exit() },
        restart: () => {},
        writeReport: () => new Promise<string | undefined>(() => {}),
      })
      const reported = recovery.report(new Error('fatal failure'), 'host')
      await vi.advanceTimersByTimeAsync(CRASH_REPORT_WAIT_MS)
      await reported
      expect(shown).toHaveLength(1)
      expect(String(shown[0].detail)).not.toContain('Crash report written to:')
      expect(exit).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the dialog when the report write rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { recovery, shown, show } = fixture({ reportPath: undefined, reportError: new Error('disk full') })
    await recovery.report(new Error('fatal failure'), 'host')
    expect(show).toHaveBeenCalled()
    expect(String(shown[0].detail)).not.toContain('Crash report written to:')
    expect(consoleError).toHaveBeenCalled()
  })

  it('stringifies a non-Error failure for the dialog detail', async () => {
    const { recovery, shown } = fixture()
    await recovery.report('plain fatal string', 'main')
    expect(String(shown[0].detail)).toContain('plain fatal string')
  })

  it('still exits when stopping fails on the exit choice', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { recovery, exit, restart, stop } = fixture()
    stop.mockRejectedValue(new Error('stop refused'))
    await recovery.report(new Error('fatal failure'), 'host')
    expect(exit).toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
  })
})
