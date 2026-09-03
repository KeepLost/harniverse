import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { CodeBindingFunction, CodeBindingNamespace, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { describe, expect, it } from 'vitest'
import { PythonCodeRuntime } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const execFileAsync = promisify(execFile)

async function hasPython3(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['-c', 'import sys; raise SystemExit(sys.version_info < (3, 10))'])
    return true
  } catch {
    return false
  }
}

const python3Available = await hasPython3()
const runtimeTestTimeoutMs = process.platform === 'win32' ? 30_000 : 5_000
const extendedRuntimeTestTimeoutMs = process.platform === 'win32' ? 45_000 : 15_000
const heavyRuntimeTestTimeoutMs = process.platform === 'win32' ? 60_000 : 20_000

async function setup(config: Config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(PythonCodeRuntime, config)
  return { ctx, fiber, runtime: ctx.codeRuntime as PythonCodeRuntime }
}

function tools(functions: Record<string, (args: unknown) => Promise<unknown>>): CodeBindingNamespace[] {
  return [{
    global: 'tools',
    functions: functions as Record<string, CodeBindingFunction>,
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  }]
}

describe.skipIf(!python3Available)('PythonCodeRuntime real subprocess', { timeout: runtimeTestTimeoutMs }, () => {
  it('runs Python with top-level await/return and exposes its descriptors', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'import asyncio\nawait asyncio.sleep(0)\nreturn {"answer": 40 + 2}',
      bindings: [],
    })
    expect(runtime.language).toBe('python')
    expect(runtime.isolation).toBe('process')
    expect(result).toEqual({ logs: [], value: { answer: 42 } })
    expect(await runtime.run({ program: 'return None', bindings: [] })).toEqual({ logs: [], value: null })
    expect(await runtime.run({ program: 'return chr(0xD800)', bindings: [] }))
      .toEqual({ logs: [], value: String.fromCharCode(0xd800) })
  })

  it('captures Python stdout, stderr, and console-style output in order', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'import sys\nsys.stdout.write("one")\nsys.stderr.write("two")\nconsole.log("three", 3)\nreturn "done"',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['one', 'two', 'three 3'])
  })

  it('passes no Host environment and captures native stdout as a bounded backstop', async () => {
    const { runtime } = await setup()
    const environment = await runtime.run({ program: 'import os\nreturn dict(os.environ)', bindings: [] })
    expect(environment.value).toEqual({})
    const native = await runtime.run({ program: 'import os\nos.write(1, b"native-out")\nreturn 1', bindings: [] })
    expect(native.error).toBeUndefined()
    expect(native.logs.join('')).toContain('native-out')
  })

  it('bridges binding results and typed binding rejections', async () => {
    const { runtime } = await setup()
    const calls: unknown[] = []
    const result = await runtime.run({
      program: [
        'value = await tools.echo({"n": 21})',
        'try:',
        '    await tools.fail({})',
        'except ToolCallError as error:',
        '    failure = {"typed": isinstance(error, ToolCallError), "name": type(error).__name__, "toolName": error.toolName, "message": str(error)}',
        'return {"value": value, "failure": failure}',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { calls.push(args); return { doubled: (args as { n: number }).n * 2 } },
        fail: async () => { throw new Error('host path /private/credential should not cross') },
      }),
    })
    expect(calls).toEqual([{ n: 21 }])
    expect(result.value).toEqual({
      value: { doubled: 42 },
      failure: { typed: true, name: 'ToolCallError', toolName: 'fail', message: 'binding call failed' },
    })
  })

  it('bridges a deeply nested lossless JSON value without substituting text', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'value = "leaf"\nfor _ in range(3000):\n    value = [value]\nreturn await tools.echo(value)',
      bindings: tools({ echo: async args => args }),
    })
    expect(result.error).toBeUndefined()
    let cursor = result.value
    for (let depth = 0; depth < 3_000; depth++) {
      expect(Array.isArray(cursor)).toBe(true)
      cursor = Array.isArray(cursor) ? cursor[0] : undefined
    }
    expect(cursor).toBe('leaf')
  }, extendedRuntimeTestTimeoutMs)

  it('drops malformed and duplicate child frames without crashing or duplicate dispatch', async () => {
    const { runtime } = await setup()
    let calls = 0
    const result = await runtime.run({
      program: [
        'import os',
        'os.write(3, b"not-json\\n")',
        'os.write(3, b"\\xff\\n")',
        'frame = b\'{"type":"call","id":777,"global":"tools","name":"count","args":null}\\n\'',
        'os.write(3, frame)',
        'os.write(3, frame)',
        'return await tools.real({})',
      ].join('\n'),
      bindings: tools({
        count: async () => { calls += 1; return null },
        real: async () => 'still-running',
      }),
    })
    expect(calls).toBe(1)
    expect(result).toEqual({ logs: [], value: 'still-running' })
  })

  it('reports invalid completion values without string substitution', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'return {1, 2, 3}', bindings: [] })
    expect(result).toEqual({
      logs: [],
      error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
    })
    const exotic = await runtime.run({ program: 'class Sneaky(list):\n    pass\nreturn Sneaky([1])', bindings: [] })
    expect(exotic.error?.kind).toBe('invalid-output')
  })

  it('enforces CPU and wall-clock limits', async () => {
    if (process.platform !== 'win32') {
      const cpu = await setup({ cpuSeconds: 1, maxWallMs: 5_000 })
      const cpuResult = await cpu.runtime.run({ program: 'while True:\n    pass', bindings: [] })
      expect(cpuResult.error?.kind).toBe('timeout')
      expect(cpuResult.error?.message).toContain('CPU')
    }

    const wall = await setup({ cpuSeconds: 30, maxWallMs: 300 })
    const wallResult = await wall.runtime.run({ program: 'import asyncio\nawait asyncio.sleep(60)', bindings: [] })
    expect(wallResult.error).toEqual({ kind: 'timeout', message: 'wall-clock ceiling reached (300ms)' })
  }, process.platform === 'win32' ? runtimeTestTimeoutMs : extendedRuntimeTestTimeoutMs)

  it('applies the address-space bound only where it means address space', async () => {
    const { runtime } = await setup({ maxAddressSpaceMb: 1 })
    const result = await runtime.run({ program: 'return 1 + 1', bindings: [] })
    if (process.platform === 'linux') {
      // Linux enforces RLIMIT_AS as address space, so a 1 MiB ceiling is fatal
      // to the interpreter itself and surfaces as a process outcome.
      expect(result.error?.kind).toBe('worker-exit')
    } else {
      // Darwin aliases RLIMIT_AS onto RLIMIT_RSS and Windows has no rlimits,
      // so the bound is not applied and the run completes normally.
      expect(result).toEqual({ logs: [], value: 2 })
    }
  })

  it('aborts a running process and bounds output', async () => {
    const aborted = await setup()
    const controller = new AbortController()
    setTimeout(() => { controller.abort('sensitive reason') }, 150)
    const abortResult = await aborted.runtime.run({
      program: 'import asyncio\nawait asyncio.sleep(60)',
      bindings: [],
      signal: controller.signal,
    })
    expect(abortResult.error).toEqual({ kind: 'abort', message: 'run aborted' })

    const capped = await setup({ maxOutputBytes: 128 })
    const outputResult = await capped.runtime.run({ program: 'print("x" * 1000)\nreturn 1', bindings: [] })
    expect(outputResult.value).toBeUndefined()
    expect(outputResult.error?.kind).toBe('output-limit')
    const resultBytes = Buffer.byteLength(JSON.stringify(outputResult.logs))
      + Buffer.byteLength(JSON.stringify(outputResult.error?.message))
    expect(resultBytes).toBeLessThanOrEqual(128)
  }, extendedRuntimeTestTimeoutMs)

  it('uses serialized UTF-8 bytes at the exact completion boundary', async () => {
    const exact = await setup({ maxOutputBytes: 7 })
    expect(await exact.runtime.run({ program: 'return "€"', bindings: [] }))
      .toEqual({ logs: [], value: '€' })
    const over = await setup({ maxOutputBytes: 6 })
    expect((await over.runtime.run({ program: 'return "€"', bindings: [] })).error?.kind).toBe('output-limit')
  })

  it('re-caps a forged oversized log at the Host boundary without retaining the full string', async () => {
    const { runtime } = await setup({ maxOutputBytes: 128 })
    const result = await runtime.run({
      program: [
        'import json, os',
        'text = "start-" + ("😀\\\"" * 10000)',
        'os.write(3, (json.dumps({"type": "log", "text": text}) + "\\n").encode())',
        'while True:',
        '    pass',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs[0]?.startsWith('start-')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message)))
      .toBeLessThanOrEqual(128)
  }, heavyRuntimeTestTimeoutMs)

  it('reports pre-abort and executable startup failure as sanitized results', async () => {
    const { runtime } = await setup()
    const controller = new AbortController()
    controller.abort('/private/reason')
    expect(await runtime.run({ program: 'return 1', bindings: [], signal: controller.signal }))
      .toEqual({ logs: [], error: { kind: 'abort', message: 'run aborted' } })

    const missing = await setup({ pythonExecutable: 'dsh-python-does-not-exist' })
    expect(await missing.runtime.run({ program: 'return 1', bindings: [] }))
      .toEqual({ logs: [], error: { kind: 'worker-exit', message: 'python process could not start' } })
  })

  it('uses a fresh process for every run', async () => {
    const { runtime } = await setup()
    await runtime.run({ program: 'global leaked\nleaked = "value"\nreturn 1', bindings: [] })
    const second = await runtime.run({ program: 'return "leaked" in globals()', bindings: [] })
    expect(second.value).toBe(false)
  }, heavyRuntimeTestTimeoutMs)

  it('disposes to quiescence and rejects later service misuse', async () => {
    const { fiber, runtime } = await setup()
    const inflight: Promise<CodeRunResult> = runtime.run({ program: 'while True:\n    pass', bindings: [] })
    await new Promise(resolve => setTimeout(resolve, 150))
    await fiber.dispose()
    expect((await inflight).error).toEqual({ kind: 'abort', message: 'runtime disposed' })
    await expect(runtime.run({ program: 'return 1', bindings: [] })).rejects.toThrow(/after disposal/)
  }, 15_000)

  it('removes ctx.codeRuntime when its fiber disposes', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.get('codeRuntime')).toBeInstanceOf(PythonCodeRuntime)
    await fiber.dispose()
    expect(ctx.get('codeRuntime')).toBeUndefined()
  })
})

describe('PythonCodeRuntime service contract validation', () => {
  it('rejects invalid config and portable binding names', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PythonCodeRuntime, { pythonExecutable: '' })).rejects.toThrow(/pythonExecutable/)
    await expect(ctx.plugin(PythonCodeRuntime, { cpuSeconds: 0 })).rejects.toThrow(/cpuSeconds/)

    if (!python3Available) return
    const { runtime } = await setup()
    await expect(runtime.run({ program: 'return 1', bindings: [{ global: '$tools', functions: {} }] })).rejects.toThrow(/usable identifier/)
    await expect(runtime.run({ program: 'return 1', bindings: [{ global: 'lambda', functions: {} }] })).rejects.toThrow(/usable identifier/)
    await expect(runtime.run({ program: 'return 1', bindings: [{ global: '__dsh_main__', functions: {} }] })).rejects.toThrow(/reserved binding global/)
  })
})
