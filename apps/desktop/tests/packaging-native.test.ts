/** Windows PTY ownership regressions run without a Windows or Electron download. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/packaging-native-pty.cjs', import.meta.url))

for (const outcome of ['success', 'missing-output', 'nonzero', 'signal', 'timeout', 'cleanup-retry', 'cleanup-failure']) {
  void test(`Windows PTY ${outcome} drains its owned worker and subscriptions`, () => {
    const result = spawnSync(process.execPath, [fixture, outcome], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.error, undefined, `probe did not naturally drain: ${result.error?.message}; ${result.stderr}`)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { outcome, workerStopped: true, subscriptionsDisposed: true })
  })
}
