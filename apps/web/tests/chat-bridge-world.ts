/**
 * Shared world for the keyless chat bridge e2e. The scaffold's web composition
 * runs with real Grant authentication; this module then drives the SHIPPED
 * `dsh chat` composition against it through the real Loader, exactly as the
 * launcher would: `init` registers the `chat-bridge` Grant and prints an owner
 * pairing code, and a bare `dsh chat` mounts the bridge rows. The only
 * substitution is a `chat-adapter-fake` row in place of Telegram or Feishu, so
 * every request the bridge makes crosses the real HTTP `/api` and `events.mux`.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { assertEntriesLoaded, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createAuthenticationClientGrant } from '@deepseek-ai/dsh-authentication-local'
import type { ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import type { FakeChatAdapter, FakeOutbound } from '@deepseek-ai/dsh-chat-adapter-fake'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { REPO_ROOT } from './support.ts'
import type { WebScaffold } from './scaffold.ts'

const CHAT_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/chat-app/cordis.patch.yml')
/**
 * The fake platform is test support, so it is not in the dsh installation's module
 * fallback (which mirrors the CLI's dependency closure); the Loader takes its built
 * entry by file URL instead.
 */
const FAKE_ADAPTER_ENTRY = pathToFileURL(join(REPO_ROOT, 'packages/test-support/chat-adapter-fake/lib/index.js')).href

/** Platform user id the e2e pairs as the bridge owner. */
export const OWNER_ID = '1001'
/** Platform user id nobody configured. */
export const STRANGER_ID = '2002'
/** Platform user id of a statically whitelisted member. */
export const MEMBER_ID = '3003'

/** A text turn the replayed model emits, streamed in `parts`. */
export interface ScriptedTextTurn {
  kind: 'text'
  parts: string[]
}

/** A tool call the replayed model emits. */
export interface ScriptedToolTurn {
  kind: 'tool'
  name: string
  arguments: unknown
}

/** Options for {@link mountChatWorld}. */
export interface ChatWorldOptions {
  /** Config of the shipped `chat-bridge` row; owners default to none because the owner pairs with the printed code. */
  bridge?: Record<string, unknown>
}

/** A mounted bridge and the fake platform in front of it. */
export interface ChatWorld {
  /** The chat root holding the shipped composition. */
  chat: Context
  /** The fake platform adapter mounted through the Loader. */
  adapter: FakeChatAdapter
  /** Grant name `dsh chat init` registered for the bridge. */
  grantName: string
  /** The one-time owner pairing code `dsh chat init` printed. */
  ownerCode: string
  /** Everything `dsh chat init` wrote to stdout. */
  initOutput: string
  /** Deliver one direct message from `userId` and wait for the bridge to accept it. */
  say: (userId: string, text: string) => Promise<void>
  /** Deliver a button press on an interaction card from `userId`. */
  click: (userId: string, actionId: string, interactionId?: string) => Promise<void>
  /** Deliver one inbound event unchanged. */
  send: (event: ChatInbound) => Promise<void>
  /** Text of every send or edit after transcript index `from`. */
  texts: (from?: number) => string[]
  /** Text of every send or edit addressed to `userId`'s private chat after transcript index `from`. */
  textsFor: (userId: string, from?: number) => string[]
  /** Interaction cards sent so far. */
  interactions: () => Array<Extract<FakeOutbound, { kind: 'interaction' }>>
  /** Dispose the chat root. */
  close: () => Promise<void>
}

/** SPKI DER (base64url) public half of a fresh P-256 key. */
function publicKeyOf(pair: { publicKey: KeyObject }): string {
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

/** The outcome of one booted `dsh chat` invocation. */
interface Booted {
  ctx: Context
  /** Resolves with the exit code once a one-shot operation asks to exit. */
  exited: Promise<number>
  out: () => string
  err: () => string
}

/**
 * Boot the shipped chat composition under `profileRoot` with `args` as the command line.
 * @param profileRoot - directory holding an empty `cordis.yml`.
 * @param args - the inner arguments after `dsh chat`.
 * @param overlays - test patches applied after the shipped layer.
 * @returns the booted root and its captured output.
 */
async function bootChat(profileRoot: string, args: string[], overlays: PatchOptions[]): Promise<Booted> {
  let out = ''
  let err = ''
  // The Loader imports the BUILT packages, so their stream singletons are not the
  // ones a test import would reach; capture at the process streams instead.
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true })
  try {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(profileRoot).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    const exited = new Promise<number>((resolve) => { provideCmdline(ctx, { args, exit: resolve }) })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const patches = [...loadOverlayPatches('chat e2e', CHAT_PATCH_PATH), ...overlays]
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(profileRoot, 'cordis.yml')).href, patches } })
    await ctx.loader.await()
    assertEntriesLoaded(ctx, 'chat e2e')
    // A one-shot operation prints and exits asynchronously; wait for it while output is still captured.
    const finished = args.length > 0 ? await exited : undefined
    return { ctx, exited: Promise.resolve(finished ?? 0), out: () => out, err: () => err }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

/**
 * Register the Grants, run `dsh chat init`, then start `dsh chat` against the scaffold.
 * @param scaffold - a scaffold booted with `authentication: 'grant'`.
 * @param options - bridge row overrides.
 * @returns the mounted world.
 */
export async function mountChatWorld(scaffold: WebScaffold, options: ChatWorldOptions = {}): Promise<ChatWorld> {
  const dshHome = scaffold.harnessHome
  // The first active Grant must authorize; it stands in for the owner's browser device.
  await createAuthenticationClientGrant({
    name: 'e2e-owner', publicKey: publicKeyOf(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })),
    capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
  }, { dshHome })

  const profileRoot = join(dshHome, 'profiles', 'chat-e2e')
  await mkdir(profileRoot, { recursive: true })
  await writeFile(join(profileRoot, 'cordis.yml'), '[]\n')

  // `dsh chat init`: the signing key, the Grant, the template, and the owner code.
  const init = await bootChat(profileRoot, ['init'], [])
  const initCode = await init.exited
  await init.ctx.fiber.dispose()
  expect(initCode, init.err()).toBe(0)
  const ownerCode = /owner pairing code \(valid \d+ minutes\): (\S+)/.exec(init.out())?.[1]
  if (ownerCode === undefined) throw new Error(`chat e2e: init printed no owner code:\n${init.out()}`)

  // Bare `dsh chat`: the shipped bridge rows with the fake platform in place of Telegram and Feishu.
  const imRoot = join(scaffold.workspaceCwd, 'im')
  await mkdir(imRoot, { recursive: true })
  const run = await bootChat(profileRoot, [], [
    { id: 'chat-client', config: { origin: scaffold.baseUrl, reconnectMinMs: 100, reconnectMaxMs: 1_000 } },
    {
      id: 'chat-bridge',
      config: { workspaceAliases: { work: scaffold.workspaceCwd }, imRoot, streamIntervalMs: 0, ...options.bridge },
    },
    { insert: [{ id: 'chat-fake', name: FAKE_ADAPTER_ENTRY, config: { platform: 'fake', botId: 'e2e-bot' } }] },
  ])
  const chat = run.ctx
  const adapter = chat.chatAdapters.get('fake', 'e2e-bot') as FakeChatAdapter
  await vi.waitFor(() => { expect(adapter.running).toBe(true) })

  let messages = 0
  const route = (userId: string): { kind: 'direct'; chatId: string } => ({ kind: 'direct', chatId: userId })
  const world: ChatWorld = {
    chat, adapter, grantName: 'chat-bridge', ownerCode, initOutput: init.out(),
    say(userId, text) {
      messages += 1
      return adapter.enqueue({
        type: 'message', messageId: `e2e-${String(messages)}`, route: route(userId), sender: { userId, isBot: false },
        addressed: true, text, controlText: text, attachments: [], platformTime: Date.now(),
      })
    },
    click: (userId, actionId, interactionId = 'e2e-card') => adapter.enqueue({
      type: 'interaction', interactionId, actionId, route: route(userId), sender: { userId, isBot: false },
    }),
    send: event => adapter.enqueue(event),
    texts: (from = 0) => adapter.transcript.slice(from).flatMap((entry: FakeOutbound) => entry.kind === 'send' || entry.kind === 'edit' ? [entry.message.text] : []),
    textsFor: (userId, from = 0) => adapter.transcript.slice(from).flatMap((entry: FakeOutbound) => {
      if (entry.kind === 'send') return entry.route.chatId === userId ? [entry.message.text] : []
      if (entry.kind === 'edit') return entry.ref.route.chatId === userId ? [entry.message.text] : []
      return []
    }),
    interactions: () => adapter.transcript.filter((entry): entry is Extract<FakeOutbound, { kind: 'interaction' }> => entry.kind === 'interaction'),
    async close() {
      await chat.fiber.dispose()
    },
  }
  return world
}

/** Chunk sequence of one replayed model call. */
function textCall(parts: string[]): unknown {
  const text = parts.join('')
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...parts.map(part => ({ type: 'text-delta', index: 0, text: part })),
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: Math.max(1, parts.length) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

/** Chunk sequence of one replayed model call that ends in a tool call. */
function toolCall(name: string, args: unknown, id: string): unknown {
  const serialized = JSON.stringify(args)
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}

/**
 * Build a `replay.override.json` document from scripted model turns.
 * @param turns - one entry per model call, in order; `hang` waits for cancellation.
 * @param readyFile - marker a `hang` turn writes once it is parked.
 * @returns the JSON text for a replace-whole-script override.
 */
export function scriptedOverride(turns: Array<ScriptedTextTurn | ScriptedToolTurn | { kind: 'hang' }>, readyFile?: string): string {
  return JSON.stringify(turns.map((turn, index): unknown => {
    switch (turn.kind) {
      case 'text': return textCall(turn.parts)
      case 'tool': return toolCall(turn.name, turn.arguments, `call_e2e_${String(index)}`)
      case 'hang': return readyFile === undefined ? { kind: 'hang' } : { kind: 'hang', readyFile }
    }
  }))
}
