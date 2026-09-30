import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, anthropicTextEvents, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-pi-ai')

/** Minimal foreign adapter: only needs to own a route the pi-ai plugin then wants. */
class StubAdapter extends LlmAdapter {

  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Real dynamic composition mirroring the deepseek twin's harness. */
async function boot(dir: string, config: LlmPiAi.Config, environment?: LaunchEnvironmentSnapshot): Promise<Context> {
  const ctx = new Context()
  if (environment !== undefined) ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('request-level dynamic profiles', () => {
  it('materializes provider-owned ambient references and builds OpenAI and Anthropic requests remotely', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const localDir = await home()
    const openai = await mockServer([{ events: textEvents }])
    const anthropic = await mockServer([{ events: anthropicTextEvents }])
    const local = await boot(localDir, {
      providers: {
        openai: {
          api: 'openai-completions',
          baseURL: `${openai.url}/v1`,
          models: [{ id: 'fake-openai', contextWindow: 100_000, maxTokens: 4096 }],
        },
        anthropic: {
          api: 'anthropic-messages',
          baseURL: `${anthropic.url}/v1`,
          models: [{ id: 'fake-anthropic', contextWindow: 200_000, maxTokens: 4096 }],
        },
      },
    }, createLaunchEnvironmentSnapshot([{ source: 'process', values: {
      OPENAI_API_KEY: 'fake-openai-key',
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
    } }]))

    const materialized = await local.settings.materialize(NS) as LlmPiAi.Config
    expect(materialized.providers?.openai?.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(materialized.providers?.anthropic?.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
    expect(JSON.stringify(materialized)).not.toContain('fake-openai-key')
    expect(JSON.stringify(materialized)).not.toContain('fake-anthropic-key')

    const remoteDir = await home()
    await writeFile(join(remoteDir, '.credentials.yaml'), [
      'OPENAI_API_KEY: fake-openai-key',
      'ANTHROPIC_API_KEY: fake-anthropic-key',
      '',
    ].join('\n'), { mode: 0o600 })
    const remote = await boot(remoteDir, materialized)
    await expect(assemble(remote, { provider: 'openai', model: 'fake-openai', messages: [] })).resolves.toMatchObject({
      finish: { kind: 'stop' },
    })
    await expect(assemble(remote, { provider: 'anthropic', model: 'fake-anthropic', messages: [] })).resolves.toMatchObject({
      finish: { kind: 'stop' },
    })
    expect(openai.paths).toEqual(['/v1/chat/completions'])
    expect(openai.headers[0]?.authorization).toBe('Bearer fake-openai-key')
    expect(anthropic.paths).toEqual(['/v1/messages'])
    expect(anthropic.headers[0]?.['x-api-key']).toBe('fake-anthropic-key')
  })

  it('preserves Anthropic provider-selected bearer authentication across sync', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', '')
    const localDir = await home()
    const server = await mockServer([{ events: anthropicTextEvents }])
    const local = await boot(localDir, {
      providers: {
        anthropic: {
          api: 'anthropic-messages',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'fake-anthropic-bearer', contextWindow: 200_000, maxTokens: 4096 }],
        },
      },
    }, createLaunchEnvironmentSnapshot([{ source: 'process', values: {
      ANTHROPIC_AUTH_TOKEN: 'fake-anthropic-bearer-token',
    } }]))
    const materialized = await local.settings.materialize(NS) as LlmPiAi.Config
    expect(materialized.providers?.anthropic?.apiKeyEnv).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(materialized.providers?.anthropic?.authMode).toBe('bearer')

    const remoteDir = await home()
    await writeFile(join(remoteDir, '.credentials.yaml'), 'ANTHROPIC_AUTH_TOKEN: fake-anthropic-bearer-token\n', { mode: 0o600 })
    const remote = await boot(remoteDir, materialized)
    const result = await assemble(remote, { provider: 'anthropic', model: 'fake-anthropic-bearer', messages: [] })
    if (result.finish.kind !== 'stop') throw new Error(JSON.stringify(result.finish))
    expect(server.headers[0]?.authorization).toBe('Bearer fake-anthropic-bearer-token')
    expect(server.headers[0]?.['x-api-key']).toBeUndefined()
  })

  it('authenticates a hand-declared bearer route from its stored credential', async () => {
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'ACME_GATEWAY_TOKEN: acme-bearer-token\n', { mode: 0o600 })
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'ACME_GATEWAY_TOKEN',
          authMode: 'bearer',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'acme-large', contextWindow: 65_536, maxTokens: 4096 }],
        },
      },
    })

    await expect(assemble(ctx, { provider: 'acme-gateway', model: 'acme-large', messages: [] }))
      .resolves.toMatchObject({ finish: { kind: 'stop' } })
    expect(server.headers[0]?.authorization).toBe('Bearer acme-bearer-token')
  })

  it('pins a host with no ambient credential so the remote cannot use its unrelated environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'remote-unrelated-key')
    const localDir = await home()
    const server = await mockServer([{ events: textEvents }])
    const local = await boot(localDir, {
      providers: {
        openai: {
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'fake-openai-unconfigured', contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    const materialized = await local.settings.materialize(NS) as LlmPiAi.Config
    expect(materialized.providers?.openai?.apiKeyEnv).toBeUndefined()
    expect(materialized.providers?.openai?.authMode).toBe('none')

    const remote = await boot(await home(), materialized)
    const result = await assemble(remote, { provider: 'openai', model: 'fake-openai-unconfigured', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.requests).toHaveLength(0)
  })

  it('materializes a provider reference when the standard credential is persisted', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    const localDir = await home()
    await writeFile(join(localDir, '.credentials.yaml'), 'OPENAI_API_KEY: fake-persisted-openai-key\n', { mode: 0o600 })
    const local = await boot(localDir, { providers: { openai: {} } }, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))

    const materialized = await local.settings.materialize(NS) as LlmPiAi.Config
    expect(materialized.providers?.openai?.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(materialized.providers?.openai?.authMode).toBe('api-key')
  })

  it('materializes from the launch environment alone without a credentials service, pinning routes pi-ai cannot resolve', async () => {
    const localDir = await home()
    // No LocalCredentialProvider: the launch-environment snapshot is the whole
    // credential plane, exactly like a host booted without the local plugin.
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {
      OPENAI_API_KEY: 'ambient-openai-key',
      CLOUDFLARE_API_KEY: 'ambient-cloudflare-key',
    } }]))
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(localDir, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmPiAi, {
      providers: {
        // Not in the installed catalog: no provider-native discovery exists.
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:1/v1',
          models: [{ id: 'acme-large', contextWindow: 65_536, maxTokens: 4096 }],
        },
        // pi-ai ships no env-key name for Bedrock, so nothing is discoverable.
        'amazon-bedrock': {},
        // A resolvable key name, but Cloudflare also needs the account id
        // beside it, which a one-name ambient probe cannot supply.
        'cloudflare-workers-ai': {},
        openai: {},
        // An explicit reference is never second-guessed by ambient discovery.
        deepseek: { apiKeyEnv: 'PI_EXPLICIT_KEY' },
      },
    })

    const materialized = await ctx.settings.materialize(NS) as LlmPiAi.Config
    expect(materialized.providers?.openai).toMatchObject({ apiKeyEnv: 'OPENAI_API_KEY', authMode: 'api-key' })
    expect(materialized.providers?.deepseek?.apiKeyEnv).toBe('PI_EXPLICIT_KEY')
    expect(materialized.providers?.['acme-gateway']?.authMode).toBe('none')
    expect(materialized.providers?.['amazon-bedrock']?.authMode).toBe('none')
    expect(materialized.providers?.['cloudflare-workers-ai']?.authMode).toBe('none')
    expect(materialized.providers?.['cloudflare-workers-ai']?.apiKeyEnv).toBeUndefined()
    expect(JSON.stringify(materialized)).not.toContain('ambient-openai-key')
    expect(JSON.stringify(materialized)).not.toContain('ambient-cloudflare-key')
  })

  it('fails an explicit missing credential without falling back to ambient discovery', async () => {
    vi.stubEnv('PI_MISSING_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-openai-key')
    const dir = await home()
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKeyEnv: 'PI_MISSING_KEY', baseURL: `${server.url}/v1` } },
    })

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(server.requests).toHaveLength(0)
  })

  it('mounts bare and dormant, then registers routes the moment settings supply providers', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_DYNAMIC_KEY: pk-from-settings\nPI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    // The exact product posture: `- id: llm-pi-ai` with no config at all.
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: every installed catalog provider is configurable
    // before any route exists, each addressed inside the providers dict.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.length).toBeGreaterThan(30)
    expect(directory).toContainEqual({
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
    })
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    await expect(ctx.llm.listModels('deepseek')).resolves.not.toHaveLength(0)

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer pk-from-settings')

    // Emptying the user layer returns the adapter to its dormant state.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('adds a provider route from settings and drops it when the user layer resets', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: 'http://127.0.0.1:1/v1' } },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai', 'deepseek'])

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer live-key')

    // Reset the user layer: the settings-born route unregisters, the
    // composition route stays.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    const removed = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(removed.finish).toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } })
  })

  it('rotates the per-request credential referenced by apiKeyEnv', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'PI_DYNAMIC_KEY: pk-one\n', { mode: 0o600 })
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer pk-one')

    await ctx.credentials.set(credentialRef('PI_DYNAMIC_KEY'), 'pk-two')
    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[1]?.authorization).toBe('Bearer pk-two')
  })

  it('re-registers routes in place when a captured retry policy changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    await ctx.settings.update(NS, {
      providers: {
        openai: {
          retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
        },
      },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('refuses a settings write this adapter could not serve, leaving its routes alone', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    // Shape-valid but unserviceable: a route the catalog does not ship and
    // that lists no models of its own. The section schema resolves the whole
    // profile set, so this is refused where it is written rather than stored
    // and then quietly disabling every route in the namespace.
    await expect(ctx.settings.update(NS, { providers: { 'not-a-real-provider': {} } }))
      .rejects.toThrow(/resolves no models/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])

    // A header Fetch cannot represent is refused with the rest of the
    // profile, so it can never reach a discovery probe or model request.
    await expect(ctx.settings.update(NS, {
      providers: { openai: { headers: { 'bad header name': 'value' } } },
    })).rejects.toThrow(/provider "openai" header "bad header name" is not valid for Fetch/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('keeps serving its routes when a settings-born route collides with another adapter', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, { providers: { openai: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: `${server.url}/v1` } } })
    // Another adapter owns `anthropic`; the registry must refuse to hand it over.
    ctx.llm.registerAdapter(['anthropic'], new StubAdapter())

    await ctx.settings.update(NS, {
      providers: {
        openai: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: `${server.url}/v1` },
        anthropic: { apiKeyEnv: 'PI_OTHER_KEY' },
      },
    })

    // The conflicting swap was refused whole: the previous route set still
    // owns openai (an eager dispose would have dropped it), and anthropic
    // still belongs to its original adapter.
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['anthropic', 'openai'])
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])

    // Reverting to the working configuration re-applies, even though its
    // facts equal the ones the registry already holds.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['anthropic', 'openai'])
    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(server.paths).toEqual(['/v1/responses', '/v1/responses'])
  })

  it('ignores a settings document that merely reorders its provider keys', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {}, anthropic: {} } })
    const before = ctx.llm.listProviders().map(provider => provider.id)

    // Same routes, different YAML key order: nothing about the registration
    // changed, so no swap should happen at all.
    await ctx.settings.update(NS, { providers: { anthropic: {}, openai: {} } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(before)
  })
})
