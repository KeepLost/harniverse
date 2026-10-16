/**
 * Registration and lifecycle: one apply registers the dictionaries, the
 * `mcp` settings section (id, order, live label), and its nav glyph, and
 * every registration leaves with the plugin fiber (the HMR-safety rule).
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-mcp/client'
import { zh } from '../src/client/locales.ts'
import { McpNavIcon } from '../src/client/NavIcon.tsx'
import { McpSection } from '../src/client/McpSection.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

/** The joined status answer the remote double serves. */
const STATUS_ROWS = [{ id: 'docs', serverName: 'docs', state: 'connected', connectedAtMs: 1, failedAttempts: 0, maxAttempts: 8, lastErrorKind: undefined, tools: [] }]

/** One catalog answer selecting the `docs` server for a preset. */
const CATALOG_SELECTED = { entries: [{ id: `mcp-server:${Array.from(new TextEncoder().encode('docs'), byte => byte.toString(16).padStart(2, '0')).join('')}`, kind: 'mcp-server', selected: true }] }

async function bench(options: { roster?: 'ok' | 'fail' | 'absent'; catalog?: 'ok' | 'mixed' | 'fail'; status?: 'ok' | 'throw' } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const listeners = new Map<string, Set<() => void>>()
  const catalogEntries = options.catalog === 'mixed'
    ? [...CATALOG_SELECTED.entries, { id: 'other:x', kind: 'agent-profile', selected: true }, { id: 'mcp-server:776562', kind: 'mcp-server', selected: false }]
    : CATALOG_SELECTED.entries
  ctx.provide('remote', {
    $on: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return () => { set.delete(listener) }
    },
    $mount: () => Promise.resolve(() => Promise.resolve()),
    mcpManagement: {
      status: vi.fn(() => options.status === 'throw' ? Promise.reject(new Error('remote gone')) : Promise.resolve({ ok: true as const, value: STATUS_ROWS })),
      restart: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    },
    capabilityManagement: {
      catalog: vi.fn(() => options.catalog === 'fail' ? Promise.resolve({ ok: false as const, error: { message: 'denied' } }) : Promise.resolve({ ok: true as const, value: { entries: catalogEntries } })),
    },
  })
  const roster = options.roster ?? 'ok'
  ctx.provide('connection', roster === 'absent'
    ? {}
    : {
      api: { agentPresets: { list: () => roster === 'fail' ? Promise.resolve({ result: { ok: false as const } }) : Promise.resolve({ result: { ok: true as const, value: { presets: [{ id: 'standard' }] } } }) } },
    })
  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { servers: [{ id: 'docs', serverName: 'docs', enabled: true, transport: 'stdio' as const, command: 'docs-mcp' }] },
      writable: true,
    }),
    subscribe: (_listener: () => void) => () => {},
    set: vi.fn(() => Promise.resolve()),
  }
  ctx.provide('settingsScope', { bind: () => scope })
  return { ctx, slots: ctx.slots as SlotRegistry, scope }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.nav.icon': { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-mcp apply', () => {
  it('declares exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'settingsScope'])
  })

  it('registers the section at id mcp with order 17, the shipped label, and the nav glyph', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ apply, inject }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'mcp')
    expect(section?.component).toBe(McpSection)
    expect(section?.options).toMatchObject({ id: 'mcp', order: 17 })
    expect(resolveSlotLabel(section?.options.label)).toBe(zh.nav)
    expect(slots.entries('settings.nav.icon').map(entry => [entry.options.key, entry.component]))
      .toEqual([['mcp', McpNavIcon]])
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ apply, inject }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
    await vi.waitFor(() => { expect(slots.entries('settings.nav.icon')).toHaveLength(1) })
  })

  it('disposes the section and nav glyph with the plugin fiber', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = await ctx.plugin({ apply, inject }).await()

    expect(slots.entries('settings.section')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('settings.nav.icon')).toHaveLength(0)
  })

  it('binds the controller to the bound mcp scope and answers a joined read', async () => {
    const { ctx, slots, scope } = await bench()
    declareRoot(slots)
    await ctx.plugin({ apply, inject }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'mcp')
    const face = section?.inject?.() as {
      refresh: () => Promise<void>
      scope: { getSnapshot: () => { writable: boolean } }
      writeServers: (servers: ReadonlyArray<{ id: string }>) => Promise<void>
      restart: (id: string) => Promise<string | undefined>
    }
    await face.refresh()
    expect(face.scope.getSnapshot().writable).toBe(true)
    await face.writeServers([{ id: 'docs' }])
    await expect(face.restart('docs')).resolves.toBeUndefined()
    expect((scope.set as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('servers', [{ id: 'docs' }])
  })

  it.each([
    ['roster failing', { roster: 'fail' }],
    ['roster absent', { roster: 'absent' }],
    ['catalog denied', { catalog: 'fail' }],
    ['status remote gone', { status: 'throw' }],
  ] as const)('completes a joined read with %s', async (_name, options) => {
    const { ctx, slots } = await bench(options)
    declareRoot(slots)
    await ctx.plugin({ apply, inject }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'mcp')
    const face = section?.inject?.() as { refresh: () => Promise<void> }
    await expect(face.refresh()).resolves.toBeUndefined()
  })

  it('joins preset exposure from a mixed catalog answer', async () => {
    const { ctx, slots } = await bench({ catalog: 'mixed' })
    declareRoot(slots)
    await ctx.plugin({ apply, inject }).await()
    const section = slots.entries('settings.section').find(entry => entry.options.id === 'mcp')
    const face = section?.inject?.() as { refresh: () => Promise<void> }
    await expect(face.refresh()).resolves.toBeUndefined()
  })
})
