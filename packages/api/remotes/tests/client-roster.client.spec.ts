// The client half's `$mount` roster is hand-maintained, and both ways it can go
// wrong are silent or near-silent in production:
//
//   1. A namespace missing from the roster leaves the owning client plugin
//      pending on its `remote.<namespace>` inject forever, so its UI never
//      registers and nothing throws (the remoteHosts regression: the Remote
//      hosts sidebar entry simply never appeared).
//   2. A Remote method whose exported name collides with the namespace service
//      it is projected onto throws only when that contribution is mounted, so
//      the whole assembly fails to load (`remoteHosts/remove` against the
//      service's own `remove` unmount path).
//
// This suite mounts the roster through the REAL Gateway client, so a collision
// fails here, and checks the mount against the injects the shipped client
// plugins actually declare, so a missing entry fails here too.
import { readFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import { apply, inject } from '../src/client/index.ts'

/** Repository root: this file sits at `<root>/packages/api/remotes/tests`. */
const root = resolve(import.meta.dirname, '../../../..')

/** The mounted roster, in assembly order, as `remote.<namespace>` keys. */
const EXPECTED_NAMESPACES = [
  'commands',
  'goals',
  'dynamicCordisRunner',
  'fileReferences',
  'pluginInventory',
  'capabilityManagement',
  'messageFeedback',
  'sessionReferenceResolver',
  'scheduler',
  'governor',
  'queue',
  'remoteHosts',
] as const

/**
 * Read the `export const inject` array of every workspace client entry.
 * The entries are static source, so no build and no module execution is needed.
 * @returns every `remote.<name>` service name the client plugins require.
 */
async function requiredRemoteNames(): Promise<Set<string>> {
  const required = new Set<string>()
  let entries = 0
  for await (const file of glob('packages/*/*/src/client/index.ts', { cwd: root })) {
    const match = /export const inject = \[([^\]]*)\]/.exec(readFileSync(join(root, file), 'utf8'))
    if (match === null) continue
    entries += 1
    for (const candidate of match[1]!.matchAll(/'remote\.([^']+)'/g)) required.add(candidate[1]!)
  }
  // A scan that matched nothing would let the roster check below pass vacuously.
  expect(entries).toBeGreaterThan(0)
  return required
}

/**
 * Boot the real Gateway client over a stub carrier and mount the assembly.
 * Mounting runs the production descriptor validation, so a method-name
 * collision against the namespace service surfaces as a rejection here.
 * @returns the Client Context after every contribution is mounted.
 */
async function mountRoster(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', { rpc: { call: vi.fn() } } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: gatewayInject, apply: applyGateway }).await()
  try {
    await apply(ctx)
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
  return ctx
}

describe('client Remote roster', () => {
  it('mounts exactly the roster, and every remote.<name> inject has its namespace', async () => {
    const ctx = await mountRoster()
    try {
      const mounted = EXPECTED_NAMESPACES.filter(name => ctx.get(`remote.${name}`) !== undefined)
      expect(mounted).toEqual([...EXPECTED_NAMESPACES])
      const required = await requiredRemoteNames()
      expect(required.size).toBeGreaterThan(0)
      expect([...required].filter(name => !mounted.includes(name as typeof EXPECTED_NAMESPACES[number]))).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects each contribution onto its own namespace with no method collision', async () => {
    const ctx = await mountRoster()
    try {
      // `removeHost` is the exported name precisely because the namespace
      // service owns `remove` as its unmount path.
      const remoteHosts = ctx.get('remote.remoteHosts') as unknown as Record<string, unknown>
      for (const method of ['list', 'upsert', 'probe', 'connect', 'disconnect', 'removeHost']) {
        expect(typeof remoteHosts[method], `remoteHosts.${method}`).toBe('function')
      }
      const endpoints = ctx.typert.remotes.list()
        .filter(descriptor => descriptor.namespace === 'remoteHosts')
        .map(descriptor => `${descriptor.namespace}/${descriptor.method}`)
        .sort()
      expect(endpoints).toEqual([
        'remoteHosts/connect',
        'remoteHosts/disconnect',
        'remoteHosts/list',
        'remoteHosts/probe',
        'remoteHosts/removeHost',
        'remoteHosts/upsert',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('withdraws every namespace when the assembly unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', { rpc: { call: vi.fn() } } as unknown as ConnectionHandle)
    await ctx.plugin({ inject: gatewayInject, apply: applyGateway }).await()
    const assembly = await ctx.plugin({ inject, apply }).await()
    expect(ctx.get('remote.remoteHosts')).toBeDefined()
    await assembly.dispose()
    for (const name of EXPECTED_NAMESPACES) expect(ctx.get(`remote.${name}`)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('requires the Client Remote service before mounting the roster', () => {
    expect(inject).toEqual(['remote'])
  })
})
