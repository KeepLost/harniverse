import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const run = promisify(execFile)
const built = existsSync(join(packageRoot, 'lib/typert.host.js'))
  && existsSync(join(packageRoot, 'lib/typert.remote-client.js'))

/** Plain Node must resolve both generated public exports from a built package. */
describe.skipIf(!built)('session-reference built exports', () => {
  it('loads the host and remote typert artifacts through package exports', async () => {
    const script = `
      const host = await import('@deepseek-ai/dsh-session-reference/typert')
      const remote = await import('@deepseek-ai/dsh-session-reference/remote')
      if (host.TYPERT?.package !== '@deepseek-ai/dsh-session-reference' || host.TYPERT?.face !== 'host') {
        throw new Error('invalid host typert export')
      }
      if (remote.default?.package !== '@deepseek-ai/dsh-session-reference') {
        throw new Error('invalid remote typert export')
      }
    `
    const result = await run(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageRoot,
      encoding: 'utf8',
    })

    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('')
  })
})
