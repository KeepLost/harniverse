/** Registration and validation behavior of the shell-registry settings service. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import ShellRegistryService, { SHELL_REGISTRY_SETTINGS_NAMESPACE } from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(section?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  if (section !== undefined) {
    class SeededMemorySettings extends MemorySettings {
      override doc: Record<string, unknown> = structuredClone(section ?? {})
    }
    const settingsFiber = ctx.plugin(SeededMemorySettings)
    await settingsFiber.await()
  } else {
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
  }
  const fiber = ctx.plugin(ShellRegistryService)
  await fiber
  return ctx
}

describe('@deepseek-ai/dsh-shell-registry-settings', () => {
  it('registers a restart namespace defaulting to the empty registry', async () => {
    const ctx = await boot()
    expect(ctx.settings.get(SHELL_REGISTRY_SETTINGS_NAMESPACE))
      .toEqual({ default: 'platform-default', entries: [] })
    expect(ctx.settings.describe()).toContainEqual(expect.objectContaining({
      ns: SHELL_REGISTRY_SETTINGS_NAMESPACE,
      applies: 'restart',
    }))
    expect(ctx.shellRegistry.document()).toEqual({ default: 'platform-default', entries: [] })
    await ctx.fiber.dispose()
  })

  it('follows a committed registry into the resolved document', async () => {
    const ctx = await boot()
    await ctx.settings.update(SHELL_REGISTRY_SETTINGS_NAMESPACE, {
      default: 'my-zsh',
      entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }],
    })
    expect(ctx.shellRegistry.document()).toEqual({
      default: 'my-zsh',
      entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }],
    })
    await ctx.fiber.dispose()
  })

  it('resolves a stored user section as the base layer', async () => {
    const ctx = await boot({ 'shell-registry': {
      default: 'posix',
      entries: [{ id: 'preview', path: '/usr/local/bin/pwsh-preview', label: 'pwsh preview' }],
    } })
    expect(ctx.shellRegistry.document()).toEqual({
      default: 'posix',
      entries: [{ id: 'preview', path: '/usr/local/bin/pwsh-preview', label: 'pwsh preview' }],
    })
    await ctx.fiber.dispose()
  })

  it('rejects an entry the served dialect classes cannot express', async () => {
    const ctx = await boot()
    await expect(ctx.settings.update(SHELL_REGISTRY_SETTINGS_NAMESPACE, {
      entries: [{ id: 'fishy', path: '/usr/bin/fish' }],
    })).rejects.toThrow(/unsupported shell dialect/)
    await ctx.fiber.dispose()
  })

  it('rejects reserved, malformed, and duplicate entry ids', async () => {
    const ctx = await boot()
    await expect(ctx.settings.update(SHELL_REGISTRY_SETTINGS_NAMESPACE, {
      entries: [{ id: 'posix', path: '/bin/bash' }],
    })).rejects.toThrow(/reserved/)
    await expect(ctx.settings.update(SHELL_REGISTRY_SETTINGS_NAMESPACE, {
      entries: [{ id: 'My Shell', path: '/bin/bash' }],
    })).rejects.toThrow(/slug/)
    await expect(ctx.settings.update(SHELL_REGISTRY_SETTINGS_NAMESPACE, {
      entries: [{ id: 'a', path: '/bin/bash' }, { id: 'a', path: '/bin/zsh' }],
    })).rejects.toThrow(/duplicate/)
    await ctx.fiber.dispose()
  })

  it('rejects a default addressing no registered entry', async () => {
    const ctx = await boot()
    await expect(ctx.settings.update(SHELL_REGISTRY_SETTINGS_NAMESPACE, {
      default: 'ghost',
    })).rejects.toThrow(/addresses no registered entry/)
    await ctx.fiber.dispose()
  })
})
