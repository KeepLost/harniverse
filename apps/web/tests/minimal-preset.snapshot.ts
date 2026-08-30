import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/minimal-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const PROMPT = 'Reply exactly MINIMAL_PRESET_REQUEST_OK and stop.'

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentProfile: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends the shared identity and dynamic persona with the exact schemas, then executes the one-shot shell and editor', async () => {
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    expect(agentHandle.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt'
      && JSON.stringify(event.data.content).includes('You are a helpful software engineer assistant.')))
      .toBe(true)
    const shellName = process.platform === 'win32' ? 'pwsh' : 'bash'
    const shellCommand = process.platform === 'win32' ? "Write-Output 'MINIMAL_SHELL_OK'" : "printf 'MINIMAL_SHELL_OK\\n'"
    const signal = new AbortController().signal
    const shell = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-shell-smoke'),
      name: shellName,
      arguments: { command: shellCommand, description: 'minimal shell smoke' },
      agent: agentHandle.agent,
    })
    const seedPath = join(scaffold.workspaceCwd, 'preset-smoke.txt')
    await writeFile(seedPath, 'MINIMAL_EDITOR_OK\n')
    const editor = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-editor-smoke'),
      name: 'str_replace_editor',
      arguments: { command: 'view', path: seedPath },
      agent: agentHandle.agent,
    })

    const text = (result: typeof shell): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .trimEnd()
    expect(shell.isError).toBe(false)
    expect(text(shell)).toContain('MINIMAL_SHELL_OK')

    expect({
      prompt: requestHeader.system,
      shell: text(shell).split('\n[stderr]')[0],
      editor: text(editor),
    }).toMatchInlineSnapshot(`
      {
        "editor": "Here's the content of {{cwd}}/preset-smoke.txt with line numbers (which has a total of 2 lines):
           1  MINIMAL_EDITOR_OK
           2",
        "prompt": "You are an AI agent powered by Harniverse.

      Check the [exit code: N] marker on every bash result; investigate failures before moving on.

      When you successfully create or modify files, mention the primary outputs in your final response. To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn.",
        "shell": "MINIMAL_SHELL_OK",
      }
    `)
    expect(requestHeader.tools?.map(tool => tool.name)).toEqual([shellName, 'str_replace_editor'])
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeDefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compactionHistory')).toBeDefined()
    expect(requestHeader.tools?.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'context_compact', 'compaction_history_expand', 'compaction_history_search',
    ]))
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
