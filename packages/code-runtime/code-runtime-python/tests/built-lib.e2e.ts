import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(join(pkgDir, 'lib/index.js'))
  && existsSync(join(pkgDir, 'py/bootstrap.py'))
  && existsSync(join(pkgDir, '../code-runtime/lib/index.js'))

async function hasPython3(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['--version'])
    return true
  } catch {
    return false
  }
}

const python3Available = await hasPython3()

describe.skipIf(!built || !python3Available)('Python runtime built entry (plain Node)', () => {
  it('loads lib/index.js and runs the shipped py/bootstrap.py', async () => {
    const script = `
      const { Context } = await import('@deepseek-ai/cordis')
      const { PythonCodeRuntime } = await import('@deepseek-ai/dsh-code-runtime-python')
      const ctx = new Context()
      await ctx.plugin(PythonCodeRuntime, {})
      const result = await ctx.codeRuntime.run({
        program: 'value = await tools.double({"n": 21})\\nconsole.log("value", value)\\nreturn value',
        bindings: [{ global: 'tools', functions: { double: async args => args.n * 2 } }],
      })
      console.log(JSON.stringify(result))
    `
    const { exitCode, stdout, stderr } = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgDir,
      stdin: 'ignore',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toEqual({ logs: ['value 42'], value: 42 })
  })
})
