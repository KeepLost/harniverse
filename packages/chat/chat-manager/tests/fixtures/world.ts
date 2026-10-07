/** A booted manager over scripted services: memory credentials, a stub web server, a scripted platform. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ChatAdapters from '@deepseek-ai/dsh-chat-adapter'
import ChatManager from '../../src/index.ts'
import { MemoryCredentials } from './credentials.ts'
import { seedOwner } from './owner.ts'
import { StubPlatform } from './platform.ts'

/** Options of {@link boot}. */
export interface BootOptions {
  /** Register the owner Grant `chat-bridge` provisioning needs; default true. */
  owner?: boolean
  authentication?: 'authenticated' | 'bypass'
  server?: { port: number; protocol: 'http:' | 'https:' }
  /** Text of a pre-existing `chat-bots.json`. */
  registry?: string
  /** Credentials present before boot. */
  credentials?: Record<string, string>
  /** Reuse a home (a second boot over the same files). */
  dshHome?: string
  /** Mount the platform plugin; default true. */
  platform?: boolean
}

/** One booted world. */
export interface World {
  ctx: Context
  manager: ChatManager
  credentials: MemoryCredentials
  platform: StubPlatform
  dshHome: string
  registryPath: string
  /** Withdraw the platform provider, as when its plugin is disabled. */
  withdrawPlatform(): Promise<void>
  /** Dispose the Context and remove the home unless it was supplied. */
  close(): Promise<void>
}

/**
 * Boot a manager.
 * @param options - what to seed.
 * @returns the world.
 */
export async function boot(options: BootOptions = {}): Promise<World> {
  const owned = options.dshHome === undefined
  const dshHome = options.dshHome ?? await mkdtemp(join(tmpdir(), 'dsh-chat-manager-'))
  if (options.owner !== false) await seedOwner(dshHome)
  if (options.registry !== undefined) await writeFile(join(dshHome, 'chat-bots.json'), options.registry)
  const credentials = new MemoryCredentials()
  for (const [ref, value] of Object.entries(options.credentials ?? {})) credentials.values.set(ref, value)
  const platform = new StubPlatform()
  const ctx = new Context()
  ctx.provide('credentials', credentials.asProvider())
  ctx.provide('webServer', options.server ?? { port: 41_234, protocol: 'http:' })
  ctx.provide('authentication', { mode: options.authentication ?? 'authenticated' })
  ctx.provide('storageDomain', {})
  await ctx.plugin(ChatAdapters)
  const provider = options.platform === false ? undefined : ctx.plugin(platform.plugin)
  await provider
  await ctx.plugin(ChatManager, { dshHome })
  return {
    ctx,
    manager: ctx.chatManager,
    credentials,
    platform,
    dshHome,
    registryPath: join(dshHome, 'chat-bots.json'),
    async withdrawPlatform() {
      await provider?.dispose()
    },
    async close() {
      await ctx.fiber.dispose()
      if (owned) await rm(dshHome, { recursive: true, force: true })
    },
  }
}
