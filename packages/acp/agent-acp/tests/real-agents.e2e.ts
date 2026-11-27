/**
 * Real external agents, on demand. `DSH_ACP_REAL=claude` runs one turn on the
 * Claude Code adapter, closes the harness, reopens the session, and asks what
 * the agent answered before; `DSH_ACP_REAL=codex` runs one turn on the Codex
 * adapter. Each takes its endpoint and key from the environment the agent
 * itself reads (`ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, or for Codex
 * `OPENAI_BASE_URL` and `OPENAI_API_KEY`) and runs under a scratch HOME, so
 * nothing of the person's own agent state is touched. Without the variable
 * both stay skipped.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { dispose, harness, reopen, restore, run, say, waitForIdle, type Harness } from './harness.ts'

const target = process.env.DSH_ACP_REAL
const enabled = target === 'claude' || target === 'codex'

/** The agent's environment: what it reads is passed through, never recorded, under a scratch HOME. */
function agentEnv(): { env: Record<string, string>; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'agent-acp-real-home-'))
  const pass = (names: readonly string[]): Record<string, string> => Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
  const npm = { HOME: home, npm_config_cache: join(process.env.HOME ?? '/root', '.npm') }
  if (target === 'codex') {
    return {
      home,
      env: {
        ...pass(['OPENAI_API_KEY']),
        ...npm,
        MODEL_PROVIDER: 'relay',
        RELAY_KEY: process.env.OPENAI_API_KEY ?? '',
        CODEX_CONFIG: JSON.stringify({
          model_provider: 'relay',
          model_providers: {
            relay: { name: 'relay', base_url: process.env.OPENAI_BASE_URL ?? '', env_key: 'RELAY_KEY', wire_api: 'responses' },
          },
        }),
      },
    }
  }
  return { home, env: { ...pass(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']), ...npm } }
}

/** The text of the last assistant message of a session. */
function lastReply(h: Harness, events: readonly SessionEvent[]): string {
  void h
  const message = events.findLast(event => event.type === 'assistant/message')
  return message?.type === 'assistant/message' ? JSON.stringify(message.data.message.content) : ''
}

describe.skipIf(!enabled)(`the real ${target ?? ''} adapter`, () => {
  it('answers a turn through the row, and a reopened session keeps what it answered', async () => {
    const { env, home } = agentEnv()
    const row = { agent: target === 'codex' ? 'codex-acp' : 'claude-acp', env, permission: 'reject' as const }
    const first = await harness([], row, { bare: true, persist: true })
    let firstDisposed = false
    let second: Harness | undefined
    try {
      const agent = await run(first, 'Reply with exactly the word OK and nothing else. Do not use any tools.')
      const events = agent.session.events.filter(event => !event.type.startsWith('agent/inbox/'))
      const ended = events.findLast(event => event.type === 'turn/end')
      // Codex reports a failed model call as its answer, so only the ride through the adapter is asserted.
      if (target === 'codex') {
        expect(events.some(event => event.type === 'acp/session')).toBe(true)
        expect(ended?.type === 'turn/end' ? ended.data.reason.kind : undefined).toBe('completed')
        return
      }
      expect(ended).toMatchObject({ data: { reason: { kind: 'completed' } } })
      expect(lastReply(first, events)).toMatch(/OK/i)
      await first.ctx.sessions.flush(agent.session)
      await first.ctx.fiber.dispose()
      firstDisposed = true
      second = await reopen(first, row, { bare: true, persist: true })
      const reopened = await restore(second)
      reopened.followup(say('What single word did you reply with to my previous message? Answer with that word only.'))
      await waitForIdle(second.ctx, reopened)
      const again = reopened.session.events.filter(event => !event.type.startsWith('agent/inbox/'))
      expect(lastReply(second, again)).toMatch(/OK/i)
      expect(again.filter(event => event.type === 'turn/end')).toHaveLength(2)
    } finally {
      await second?.ctx.fiber.dispose()
      if (!firstDisposed) await first.ctx.fiber.dispose()
      dispose(first)
      rmSync(home, { recursive: true, force: true })
    }
  }, 300_000)
})
