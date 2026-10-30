import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Chat flow-gap rhythm (official 2026-10-23 chat-gap absorption, adapted onto
// the flat 16px column): pins the process/response gap tokens and the sibling
// rules that override the column gap, so the rhythm cannot drift silently.
const css = await readFile(
  fileURLToPath(new URL('../src/client/chat/ChatView.module.css', import.meta.url)),
  'utf8',
)

const processKinds = [
  'tool-call',
  'command',
  'command-input',
  'workflow-run',
  'model-retry',
  'turn-error',
  'turn-max-tokens',
  'turn-tail',
  'compaction',
]

describe('chat flow-gap rhythm', () => {
  it('keeps the 16px column rhythm as the base', () => {
    expect(css).toMatch(/\.column\s*\{[^}]*gap:\s*16px/s)
  })

  it('defines the process and response gap tokens on the column', () => {
    expect(css).toMatch(/--dsh-chat-process-gap:\s*4px/)
    expect(css).toMatch(/--dsh-chat-response-gap:\s*12px/)
  })

  it('tightens every process-to-process pairing to the process gap', () => {
    for (const kind of processKinds) {
      const occurrences = css.split(`data-chat-flow-kind='${kind}'`).length - 1
      expect(occurrences, `${kind} appears in both lists and the handoff`).toBeGreaterThanOrEqual(3)
    }
    expect(css).toMatch(/margin-top:\s*calc\(var\(--dsh-chat-process-gap\) - 16px\)/)
  })

  it('hands off from every process kind to the assistant reply at the response gap', () => {
    for (const kind of processKinds) {
      expect(css, `${kind} before an assistant reply`).toMatch(
        new RegExp(`data-chat-flow-kind='${kind}'[^)]*\\)\\s*\\+\\s*\\.flowItem\\[data-chat-flow-kind='assistant-step'`),
      )
    }
    expect(css).toMatch(/margin-top:\s*calc\(var\(--dsh-chat-response-gap\) - 16px\)/)
  })

  it('leaves user messages and unknown surfaces on the base rhythm', () => {
    expect(css).not.toMatch(/\+\s*\.flowItem\[data-chat-flow-kind='user'\]/)
    expect(css).not.toMatch(/data-chat-flow-kind='unknown'/)
  })
})
