import { describe, expect, it, vi } from 'vitest'
import { filterRuntimeWarnings, quietRuntimeCall } from '../src/environment.ts'

describe('runtime warning filtering', () => {
  it('leaves states without an emitter unchanged', () => {
    const state: { emitWarning?: typeof process.emitWarning } = {}
    filterRuntimeWarnings(state)
    expect(state.emitWarning).toBeUndefined()
  })

  it('drops the runtime experimental-feature warnings in every warning shape', () => {
    const original = vi.fn()
    const state = { emitWarning: original as unknown as typeof process.emitWarning }
    filterRuntimeWarnings(state)
    const wrapped = state.emitWarning as unknown as (...args: unknown[]) => void
    wrapped('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time')
    wrapped(new Error('stripTypeScriptTypes is an experimental feature and might change at any time'))
    expect(original).not.toHaveBeenCalled()
  })

  it('forwards program warnings and unrecognized shapes with the original receiver', () => {
    const original = vi.fn()
    const state = { emitWarning: original as unknown as typeof process.emitWarning }
    filterRuntimeWarnings(state)
    const wrapped = state.emitWarning as unknown as (...args: unknown[]) => void
    wrapped('custom deprecation', 'DeprecationWarning', 'W001')
    wrapped(new Error('program warning'))
    wrapped({ opaque: true })
    expect(original).toHaveBeenCalledTimes(3)
    expect(original).toHaveBeenLastCalledWith({ opaque: true })
    expect(original.mock.calls[0]).toEqual(['custom deprecation', 'DeprecationWarning', 'W001'])
  })

  it('suppresses the runtime experimental-feature warnings around one synchronous host call', () => {
    const captured: string[] = []
    const original = process.emitWarning.bind(process)
    process.emitWarning = (warning: string | Error): void => { captured.push(String(warning)) }
    try {
      const outcome = quietRuntimeCall(() => {
        process.emitWarning('stripTypeScriptTypes is an experimental feature and might change at any time')
        process.emitWarning('kept warning')
        return 'done'
      })
      expect(outcome).toBe('done')
      expect(captured).toEqual(['kept warning'])
    } finally {
      process.emitWarning = original
    }
  })
})
