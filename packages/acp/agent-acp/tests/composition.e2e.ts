import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless REAL-composition coverage for ACP mode: a test-only cordis.yml boots
 * the headless app through the Loader with the preset roster holding one copy
 * of the shipped template, and a scripted external agent answers in a real
 * child process. The turn must run on the external agent, never the model loop.
 */

const fixtures = fileURLToPath(new URL('./fixtures/composition/', import.meta.url))
const fakeAgent = fileURLToPath(new URL('./fake-agent.ts', import.meta.url))
const template = fileURLToPath(new URL('../preset/acp/', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

/** What the driving script reports: the session's durable events. */
interface Report {
  types: string[]
  messages: ContentBlock[][]
  entered: string[]
}

describe('ACP mode through a real cordis.yml and a copied preset template', () => {
  it('drives the turn on the external agent the preset names', async () => {
    const { stderr } = await runLoaderSmoke({
      label: 'agent-acp composition smoke',
      tempDirPrefix: 'agent-acp-e2e-',
      binScript: join(fixtures, 'driver.ts'),
      libBinScript: join(fixtures, 'driver.ts'),
      configPath: join(fixtures, 'cordis.yml'),
      tsconfigPath: repoTsconfig,
      env: { DSH_TEST_REPORT: 'report.json' },
      prepare: (cwd) => {
        // The documented flow: copy the template, then set its command.
        cpSync(template, join(cwd, 'presets', 'acp'), { recursive: true })
        const composition = join(cwd, 'presets', 'acp', 'agent.cordis.yml')
        const yaml = readFileSync(composition, 'utf8')
        const replaced = yaml
          .replace('    command: claude\n', `    command: ${JSON.stringify(process.execPath)}\n`)
          .replace('    args:\n      - acp\n', `    args: ${JSON.stringify([fakeAgent])}\n`)
          .replace('    env: {}\n', `    env:\n      ACP_FAKE_SCENARIO: ${JSON.stringify(join(cwd, 'scenario.json'))}\n      ACP_FAKE_LOG: ${JSON.stringify(join(cwd, 'log.jsonl'))}\n`)
        if (replaced === yaml) throw new Error('the preset template changed: the composition test no longer finds its anchors')
        writeFileSync(composition, replaced)
        writeFileSync(join(cwd, 'scenario.json'), JSON.stringify({
          turns: [{ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the external agent answers' } }] }],
        }))
      },
      inspect: (cwd) => {
        const report = JSON.parse(readFileSync(join(cwd, 'report.json'), 'utf8')) as Report
        // The composition's own title record is written whenever its title service settles.
        expect(report.types.filter(type => type !== 'session/title')).toEqual([
          'turn/start', 'step/start', 'user/message', 'user/message', 'assistant/chunk', 'assistant/chunk',
          'assistant/message', 'step/end', 'turn/end',
        ])
        // Harness plugins still inject their context into the log; only the person's text reaches the external agent.
        expect(report.entered).toEqual(['plugin', 'user'])
        expect(report.messages).toEqual([[{ type: 'text', text: 'the external agent answers' }]])
        const requests = readFileSync(join(cwd, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: unknown })
        expect(requests.map(entry => entry.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
        expect(requests[2]?.params).toMatchObject({ sessionId: 'external-1', prompt: [{ type: 'text', text: 'hello from the harness' }] })
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(stderr).not.toContain('the model loop ran')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
