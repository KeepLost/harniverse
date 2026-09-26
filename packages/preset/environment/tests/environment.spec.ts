import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import * as Environment from '@deepseek-ai/dsh-environment'
import { ENVIRONMENT_SECTION } from '@deepseek-ai/dsh-environment'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  return ctx
}

/** The assembled text of the environment section as one scope sees it. */
async function sectionText(ctx: Context, scope?: ScopeKey): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.sections.find(section => section.name === ENVIRONMENT_SECTION)?.text
}

describe('environment fact detection', () => {
  it('describes a GNU Linux host', () => {
    expect(Environment.detectEnvironmentFacts('linux', 'box', () => false))
      .toEqual({ os: 'Linux', shell: 'bash', userland: 'GNU', machine: 'box' })
  })

  it('describes an Alpine Linux host through the BusyBox probe', () => {
    expect(Environment.detectEnvironmentFacts('linux', 'box', () => true))
      .toEqual({ os: 'Linux', shell: 'bash', userland: 'BusyBox', machine: 'box' })
  })

  it('describes macOS with zsh and the BSD userland', () => {
    expect(Environment.detectEnvironmentFacts('darwin', 'mac', () => false))
      .toEqual({ os: 'macOS', shell: 'zsh', userland: 'BSD', machine: 'mac' })
  })

  it('describes Windows with PowerShell and no userland claim', () => {
    expect(Environment.detectEnvironmentFacts('win32', 'pc', () => false))
      .toEqual({ os: 'Windows', shell: 'PowerShell', machine: 'pc' })
  })

  it('passes an unmapped platform through with the POSIX shell default', () => {
    expect(Environment.detectEnvironmentFacts('freebsd', 'bsd', () => false))
      .toEqual({ os: 'freebsd', shell: 'bash', machine: 'bsd' })
  })

  it('detects the current host without explicit inputs', () => {
    const facts = Environment.detectEnvironmentFacts()
    expect(facts.machine.length).toBeGreaterThan(0)
    expect(['Linux', 'macOS', 'Windows'].includes(facts.os) || facts.os === process.platform).toBe(true)
  })
})

describe('the environment section text', () => {
  it('states machine, OS, shell, userland, and the session-fixed working directory', () => {
    expect(Environment.environmentSectionText({ os: 'Linux', shell: 'bash', userland: 'GNU', machine: 'box' }))
      .toBe('You are working on the machine box (Linux, bash shell with a GNU userland). '
        + 'The working directory for this session is {{cwd}}; it stays fixed for the session\'s lifetime.')
  })

  it('omits the userland clause when it does not apply', () => {
    expect(Environment.environmentSectionText({ os: 'Windows', shell: 'PowerShell', machine: 'pc' }))
      .toBe('You are working on the machine pc (Windows, PowerShell shell). '
        + 'The working directory for this session is {{cwd}}; it stays fixed for the session\'s lifetime.')
  })
})

describe('the environment row', () => {
  it('contributes the section for one scope and renders with the cwd variable', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a1' }
    ctx.systemPrompt.variable('cwd', () => '/workspace')

    await createScope(ctx, key).ctx.plugin(Environment)

    const text = await sectionText(ctx, key)
    expect(text).toContain(process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux')
    expect(text).toContain('{{cwd}}')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toContain('The working directory for this session is /workspace;')
    // The section is absent for scopes that did not mount the row.
    expect(await sectionText(ctx)).toBeUndefined()
  })

  it('removes the section when its fiber unloads', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a2' }
    const scope = createScope(ctx, key)

    const fiber = await scope.ctx.plugin(Environment)
    expect(await sectionText(ctx, key)).toContain('You are working on the machine')

    await fiber.dispose()

    expect(await sectionText(ctx, key)).toBeUndefined()
  })
})
