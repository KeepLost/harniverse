/** Shared boot and event builders for the bridge suites. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ChatAdapters, { type ChatInbound, type ChatRoute } from '@deepseek-ai/dsh-chat-adapter'
import { FakeChatAdapter, type FakeOutbound } from '@deepseek-ai/dsh-chat-adapter-fake'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as Bridge from '../src/index.ts'
import type { ConfigInput } from '../src/index.ts'
import { bridgeDomainSpec, type BridgeState } from '../src/state.ts'
import { FakeClient } from './fixtures/fake-client.ts'

export const REMOTE = '3f2a8c6e-1b4d-4e7a-9c05-8d2e6f1a7b39'

const roots: string[] = []
const contexts: Context[] = []

/** Dispose every booted context and temp root. */
export async function cleanup(): Promise<void> {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

/** A booted bridge with its fakes. */
export interface Harness {
  ctx: Context
  client: FakeClient
  adapter: FakeChatAdapter
  root: string
  exits: number[]
  /** Dispose only the bridge plugin, leaving storage and the adapter registry alive. */
  stopBridge(): Promise<void>
  /** Remove the harness adapter from the registry. */
  unregister(): void
  state(): BridgeState
  /** Deliver one inbound event through the adapter and wait for the bridge to accept it. */
  send(event: ChatInbound): Promise<void>
  /** Deliver a direct message from a user. */
  say(userId: string, text: string, options?: MessageOptions): Promise<void>
  /** Texts sent (send or edit) after the given transcript index. */
  sent(from?: number): string[]
}

/** Options for {@link message}. */
export interface MessageOptions {
  id?: string
  chatId?: string
  kind?: 'direct' | 'group'
  addressed?: boolean
  displayName?: string
  isBot?: boolean
  attachments?: Array<{ attachmentId: string; name?: string; mediaType?: string; bytes?: number }>
  threadId?: string
}

let counter = 0

/**
 * Build an inbound message event.
 * @param userId - sender id.
 * @param text - body; also used as the control text.
 * @param options - overrides.
 * @returns the event.
 */
export function message(userId: string, text: string, options: MessageOptions = {}): ChatInbound {
  counter += 1
  const kind = options.kind ?? 'direct'
  const route: ChatRoute = {
    kind, chatId: options.chatId ?? (kind === 'direct' ? userId : 'group-1'),
    ...options.threadId === undefined ? {} : { threadId: options.threadId },
  }
  return {
    type: 'message',
    messageId: options.id ?? `msg-${String(counter)}`,
    route,
    sender: { userId, isBot: options.isBot ?? false, ...options.displayName === undefined ? {} : { displayName: options.displayName } },
    addressed: options.addressed ?? true,
    text,
    controlText: text,
    attachments: options.attachments ?? [],
    platformTime: 1,
  }
}

/** A member entry with the common defaults. */
export function member(overrides: Record<string, unknown> = {}): NonNullable<ConfigInput['members']>[number] {
  return {
    id: 'alice', platform: 'fake', userId: '200',
    commands: ['new', 'ask', 'stop', 'steer', 'queue', 'unqueue', 'sessions', 'session', 'ws', 'model', 'title', 'compact', 'plan'],
    workspaces: [], answerOwnApprovals: false,
    ...overrides,
  }
}

/**
 * Boot a bridge over a real storage stack, the fake adapter, and the fake client.
 * @param options - configuration and adapter overrides.
 * @returns the harness, with the adapter already running.
 */
export async function boot(options: {
  config?: ConfigInput
  capabilities?: ConstructorParameters<typeof FakeChatAdapter>[0] extends infer O
    ? NonNullable<O> extends { capabilities?: infer C } ? C : never
    : never
  owners?: string[]
  adapter?: FakeChatAdapter
  client?: FakeClient
  /** Reuse a storage root seeded by {@link seedState}. */
  root?: string
} = {}): Promise<Harness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-chat-bridge-'))
  if (options.root === undefined) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const client = options.client ?? new FakeClient()
  const exits: number[] = []
  await ctx.plugin(ChatAdapters)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('harniverseClient', client.asClient())
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  const adapter = options.adapter ?? new FakeChatAdapter({ capabilities: options.capabilities })
  const unregister = ctx.chatAdapters.register(adapter)
  const config = Bridge.Config({
    owners: (options.owners ?? ['100']).map(userId => ({ platform: 'fake', userId })),
    imRoot: join(root, 'im'),
    streamIntervalMs: 0,
    ...options.config,
  })
  const bridge = await ctx.plugin(Bridge, config)
  await vi.waitFor(() => { expect(adapter.running).toBe(true) })
  const harness: Harness = {
    ctx, client, adapter, root, exits,
    stopBridge: () => bridge.dispose(),
    unregister,
    state: () => ctx.storageDomain.get(bridgeDomainSpec.name) as unknown as BridgeState,
    send: event => adapter.enqueue(event),
    say: (userId, text, messageOptions) => adapter.enqueue(message(userId, text, messageOptions)),
    sent: (from = 0) => adapter.transcript.slice(from).flatMap((entry: FakeOutbound) => {
      switch (entry.kind) {
        case 'send':
        case 'edit': return [entry.message.text]
        case 'interaction': return [entry.prompt.body]
        default: return []
      }
    }),
  }
  return harness
}

/** Open the bridge state stored under `root`, run `use`, and close it again. */
async function withState<T>(root: string | undefined, use: (state: BridgeState, root: string) => Promise<T>): Promise<T> {
  const dir = root ?? await mkdtemp(join(tmpdir(), 'dsh-chat-bridge-'))
  if (root === undefined) roots.push(dir)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(dir, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const state = await ctx.storageDomain.open(bridgeDomainSpec)
  try {
    return await use(state, dir)
  } finally {
    await state.close()
    await ctx.fiber.dispose()
  }
}

/**
 * Create a temp root whose bridge state was written by `seed`, as a previous run would have left it.
 * @param seed - writes the state.
 * @returns the root to pass to {@link boot}.
 */
export function seedState(seed: (state: BridgeState) => Promise<void>): Promise<string> {
  return withState(undefined, async (state, root) => { await seed(state); return root })
}

/**
 * Read the state a finished run left under `root`.
 * @param root - the harness root.
 * @param read - inspects the state.
 * @returns what `read` returned.
 */
export function readState<T>(root: string, read: (state: BridgeState) => T): Promise<T> {
  return withState(root, state => Promise.resolve(read(state)))
}
