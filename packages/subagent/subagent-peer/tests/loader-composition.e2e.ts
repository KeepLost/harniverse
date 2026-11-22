import { readFile, readdir, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import { ensureInstanceIdentity } from '@deepseek-ai/dsh-peer-protocol'
import { ensurePeerIdentityKey, writePeerTargets } from '@deepseek-ai/dsh-peer-client'
import { SCRIPTED_PEER_SESSION, ScriptedPeerTarget } from './scripted-peer-target.ts'

const ID_A = peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666')

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

const roots: string[] = []
const targets: ScriptedPeerTarget[] = []

afterEach(async () => {
  await Promise.all(targets.splice(0).map(target => target.stop()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('Peer subagent backend through a real cordis.yml', () => {
  it('delegates one turn to the paired instance and renders its reply naming the peer session', async () => {
    const target = new ScriptedPeerTarget()
    const origin = await target.start()
    target.delegateRuns = [{ sessionId: SCRIPTED_PEER_SESSION, messageId: 'm1', state: 'settled', reply: 'peer composition reply', endReason: 'completed' }]
    targets.push(target)
    const home = await mkdtemp(join(tmpdir(), 'subagent-peer-e2e-'))
    roots.push(home)
    await ensureInstanceIdentity(home)
    await ensurePeerIdentityKey(home)
    await writePeerTargets(home, [{
      targetInstanceId: ID_A,
      displayName: 'Build workstation',
      endpoint: { origin },
      transport: { kind: 'direct' },
      grantName: `peer-${ID_A}`,
      grantId: 'grant-1',
      status: 'active',
      addedAt: '2026-01-01T00:00:00.000Z',
    }])

    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'subagent-peer loader composition',
      tempDirPrefix: 'subagent-peer-loader-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TEST_PEER_HOME: home, DSH_TEST_PEER_TARGET: ID_A },
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    // The one-shot tool result carries the paired instance's reply verbatim
    // and publishes the PEER session id — the id that stays continuable
    // through the `peer` model tool on the same pairing.
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const resultText = results[0]!.data.message.content[0].content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(resultText).toContain(`Subagent session ${SCRIPTED_PEER_SESSION} completed invocation`)
    expect(resultText).toContain('Final output:\npeer composition reply')
    expect(target.requests.some(call => call.url.includes('/api/peer/delegate'))).toBe(true)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
