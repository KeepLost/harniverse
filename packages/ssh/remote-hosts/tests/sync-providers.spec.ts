import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildSnapshot } from '../src/sync.ts'

it('materializes configured OpenAI and Anthropic references from the host launch environment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-sync-providers-'))
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { HOST_OPENAI_KEY: 'fake-openai-key', UNRELATED_KEY: 'fake-unrelated' } },
    { source: 'project-env', values: { HOST_ANTHROPIC_KEY: 'fake-anthropic-key' } },
  ]))
  try {
    await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
    await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openai: { apiKeyEnv: 'HOST_OPENAI_KEY', baseURL: 'https://openai-gateway.test/v1' },
        anthropic: { apiKeyEnv: 'HOST_ANTHROPIC_KEY', baseURL: 'https://anthropic-gateway.test/v1' },
      },
    })

    const snapshot = await buildSnapshot(ctx.settings, ctx.credentials)
    expect(snapshot.credentials).toEqual({ HOST_OPENAI_KEY: 'fake-openai-key', HOST_ANTHROPIC_KEY: 'fake-anthropic-key' })
    expect(snapshot.settings['llm-pi-ai']).toMatchObject({ providers: {
      openai: { apiKeyEnv: 'HOST_OPENAI_KEY', baseURL: 'https://openai-gateway.test/v1' },
      anthropic: { apiKeyEnv: 'HOST_ANTHROPIC_KEY', baseURL: 'https://anthropic-gateway.test/v1' },
    } })
    expect(JSON.stringify(snapshot.settings)).not.toContain('fake-')
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('pins ambient OpenAI and Anthropic credentials for the remote settings snapshot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-sync-ambient-'))
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: {
      OPENAI_API_KEY: 'fake-openai-ambient',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: 'fake-anthropic-ambient',
      UNRELATED_KEY: 'fake-unrelated',
    } },
  ]))
  try {
    await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
    await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: {}, anthropic: {} },
    })
    await expect(ctx.credentials.resolve(credentialRef('OPENAI_API_KEY'))).resolves.toMatchObject({ value: 'fake-openai-ambient' })
    await expect(ctx.credentials.resolve(credentialRef('ANTHROPIC_API_KEY'))).resolves.toMatchObject({ value: 'fake-anthropic-ambient' })

    const snapshot = await buildSnapshot(ctx.settings, ctx.credentials)
    const { providers } = snapshot.settings['llm-pi-ai'] as unknown as { providers: Record<string, { apiKeyEnv: string }> }
    expect(typeof providers.openai?.apiKeyEnv).toBe('string')
    expect(typeof providers.anthropic?.apiKeyEnv).toBe('string')
    expect(snapshot.credentials).toEqual({
      [providers.openai!.apiKeyEnv]: 'fake-openai-ambient',
      [providers.anthropic!.apiKeyEnv]: 'fake-anthropic-ambient',
    })
    expect(JSON.stringify(snapshot.settings)).not.toContain('fake-')
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
