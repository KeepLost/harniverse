/**
 * OAuth configuration of a Streamable HTTP entry: the resolve step from the
 * raw `oauth` field to budgeted options, its conflict with a configured
 * Authorization header, the schema's acceptance of both spellings, the
 * coded errors, and the load-time rejection before any effect registers.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client/src/config.ts'
import {
  Config as ConfigSchema,
  McpAuthorizationRequired,
  McpLocalError,
  apply,
  inject,
} from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { ownerApply } from '@deepseek-ai/dsh-mcp-client/src/owner.ts'
import { OAUTH_DEFAULTS, oauthConfigOf, resolveOAuthConfig } from '@deepseek-ai/dsh-mcp-client/src/oauth-options.ts'
import { activeServerNamesOf } from '@deepseek-ai/dsh-mcp-client/src/reservations.ts'

const SERVER = { url: 'https://mcp.example/mcp', headers: {} as Record<string, string> }
const PATH = 'mcp-client(github)'

function httpConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'streamable-http',
    serverName: 'github',
    url: SERVER.url,
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...overrides,
  }
}

describe('resolveOAuthConfig', () => {
  it('selects every default for `true` and fills only the missing budgets of an options object', () => {
    expect(resolveOAuthConfig(true, SERVER, PATH)).toEqual(OAUTH_DEFAULTS)
    expect(resolveOAuthConfig({ clientId: 'app', scope: 'mcp:tools', requestTimeoutMs: 2_500 }, SERVER, PATH))
      .toEqual({ clientId: 'app', scope: 'mcp:tools', requestTimeoutMs: 2_500, authorizationTimeoutMs: OAUTH_DEFAULTS.authorizationTimeoutMs })
    expect(resolveOAuthConfig(undefined, SERVER, PATH)).toBeUndefined()
    expect(Object.isFrozen(resolveOAuthConfig(true, SERVER, PATH))).toBe(true)
  })

  it('refuses values, unknown options, and blank identities with the option path in the message', () => {
    for (const invalid of [null, false, 'yes', 1]) {
      expect(() => { resolveOAuthConfig(invalid as never, SERVER, PATH) }).toThrow(/oauth must be true or an options object/)
    }
    expect(() => { resolveOAuthConfig({ bogus: 1 } as never, SERVER, PATH) }).toThrow(/oauth\.bogus is not an oauth option/)
    expect(() => { resolveOAuthConfig({ clientId: '  ' }, SERVER, PATH) }).toThrow(/oauth\.clientId must not be blank/)
    expect(() => { resolveOAuthConfig({ scope: '' }, SERVER, PATH) }).toThrow(/oauth\.scope must not be blank/)
  })

  it.each(['requestTimeoutMs', 'authorizationTimeoutMs'] as const)('bounds %s to a positive integer no greater than the timer ceiling', (field) => {
    for (const invalid of [0, -1, 1.5, MAX_TIMER_DELAY_MS + 1, Number.NaN, Infinity]) {
      expect(() => { resolveOAuthConfig({ [field]: invalid }, SERVER, PATH) }).toThrow(new RegExp(`oauth\\.${field} must be a positive integer`))
    }
    const ceiling = resolveOAuthConfig({ [field]: MAX_TIMER_DELAY_MS }, SERVER, PATH)
    if (ceiling === undefined) throw new Error('the ceiling resolves')
    expect(ceiling[field]).toBe(MAX_TIMER_DELAY_MS)
  })

  it('lets OAuth own the Authorization header under any spelling', () => {
    for (const name of ['Authorization', 'authorization', 'AUTHORIZATION']) {
      expect(() => { resolveOAuthConfig(true, { ...SERVER, headers: { [name]: 'Bearer x' } }, PATH) })
        .toThrow(/cannot be combined with an Authorization header/)
    }
    expect(resolveOAuthConfig(true, { ...SERVER, headers: { 'X-Api-Key': 'k' } }, PATH)).toEqual(OAUTH_DEFAULTS)
  })

  it('requires HTTPS except for a loopback HTTP endpoint', () => {
    for (const url of ['https://mcp.example/mcp', 'http://localhost:3000/mcp', 'http://127.0.0.1:3000/mcp', 'http://[::1]:3000/mcp']) {
      expect(resolveOAuthConfig(true, { ...SERVER, url }, PATH)).toEqual(OAUTH_DEFAULTS)
    }
    for (const url of ['http://mcp.example/mcp', 'http://192.168.1.5:3000/mcp', 'ftp://localhost/mcp', 'not a url']) {
      expect(() => { resolveOAuthConfig(true, { ...SERVER, url }, PATH) }).toThrow(/OAuth requires HTTPS except for loopback HTTP/)
    }
  })

  it('resolves undefined for stdio and for an entry without oauth, and refuses oauth on stdio', () => {
    const stdio = { ...httpConfig({ transport: 'stdio', url: undefined, command: 'echo', args: [], env: {}, cwd: '' }) }
    expect(oauthConfigOf(stdio as never, PATH)).toBeUndefined()
    expect(oauthConfigOf(httpConfig() as never, PATH)).toBeUndefined()
    expect(oauthConfigOf(httpConfig({ oauth: true }) as never, PATH)?.options).toEqual(OAUTH_DEFAULTS)
    expect(() => { oauthConfigOf({ ...httpConfig({ transport: 'stdio', command: 'echo', oauth: true }), url: undefined } as never, PATH) })
      .toThrow(/oauth is only valid for streamable-http/)
  })
})

describe('Config schema oauth field', () => {
  /** Resolve an entry through the schema and narrow it to its Streamable HTTP member. */
  function resolved(overrides: Record<string, unknown>): StreamableHttpConfig {
    const config = ConfigSchema(httpConfig(overrides) as never)
    if (config.transport !== 'streamable-http') throw new Error('the entry resolved as streamable-http')
    return config
  }

  it('keeps `true`, defaults an options object, and omits an absent field', () => {
    expect(resolved({ oauth: true }).oauth).toBe(true)
    expect(resolved({ oauth: { clientId: 'app' } }).oauth).toEqual({ clientId: 'app', ...OAUTH_DEFAULTS })
    expect(resolved({})).not.toHaveProperty('oauth')
    expect(() => { ConfigSchema(httpConfig({ oauth: false }) as never) }).toThrow()
  })
})

describe('coded MCP errors', () => {
  it('carries a stable code and names the authorization reason in the message', () => {
    const required = new McpAuthorizationRequired('expired')
    expect(required).toBeInstanceOf(McpLocalError)
    expect(required.code).toBe('MCP_AUTHORIZATION_REQUIRED')
    expect(required.reason).toBe('expired')
    expect(required.message).toBe('MCP OAuth requires authorization: expired')
    expect(required.name).toBe('McpAuthorizationRequired')
    expect(new McpLocalError('MCP OAuth authorization failed', 'MCP_OAUTH_FAILED')).toMatchObject({
      code: 'MCP_OAUTH_FAILED', name: 'McpLocalError', message: 'MCP OAuth authorization failed',
    })
  })
})

describe('load-time oauth validation', () => {
  async function registry(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    return ctx
  }

  it('rejects a standalone entry that combines oauth with an Authorization header before any effect registers', async () => {
    const ctx = await registry()
    await expect(apply(ctx, httpConfig({ oauth: true, headers: { authorization: 'Bearer x' } }) as never))
      .rejects.toThrow(/cannot be combined with an Authorization header/)
    expect(activeServerNamesOf(ctx.root).size).toBe(0)
    expect(ctx.tools.schemas()).toEqual([])
    expect(inject).toEqual(['tools'])
  })

  it('rejects a shared owner entry with the same conflict', async () => {
    const ctx = await registry()
    await expect(ownerApply(ctx, { ...httpConfig({ oauth: true, headers: { Authorization: 'Bearer x' } }), serverId: 'github' } as never))
      .rejects.toThrow(/mcp-client\(github\): oauth cannot be combined with an Authorization header/)
  })
})
