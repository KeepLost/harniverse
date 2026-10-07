/**
 * A programmable fake {@link ChatAdapter} for bridge unit tests, Loader
 * composition tests, and the keyless web e2e. Tests enqueue normalized
 * inbound events and assert the recorded outbound transcript; no platform
 * transport exists.
 * @module @deepseek-ai/dsh-chat-adapter-fake
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ChatAdapter, ChatAdapterCapabilities, ChatAttachmentRef, ChatInbound, ChatInboundSink,
  ChatPlatformId, ChatRoute, InteractionPrompt, InteractionSettlement, OutboundFile,
  OutboundMessage, SentRef,
} from '@deepseek-ai/dsh-chat-adapter'

/** One recorded outbound call, in call order. */
export type FakeOutbound =
  | { kind: 'send'; route: ChatRoute; message: OutboundMessage; ref: SentRef }
  | { kind: 'edit'; ref: SentRef; message: OutboundMessage }
  | { kind: 'recall'; ref: SentRef }
  | { kind: 'interaction'; route: ChatRoute; prompt: InteractionPrompt; ref: SentRef }
  | { kind: 'settle'; ref: SentRef; state: InteractionSettlement }
  | { kind: 'file'; route: ChatRoute; file: OutboundFile; ref: SentRef }
  | { kind: 'typing'; route: ChatRoute }

/** Outbound operation names that {@link FakeChatAdapter.failNext} can target. */
export type FakeOutboundKind = FakeOutbound['kind']

/** Programmable attachment bytes served by {@link FakeChatAdapter.fetchAttachment}. */
export interface FakeAttachmentSource {
  bytes: Uint8Array<ArrayBuffer>
  mediaType: string
}

/** Capability defaults: a fully capable platform with instant edits. */
export const FAKE_CAPABILITIES: ChatAdapterCapabilities = {
  groupChats: true,
  threads: true,
  editOutbound: true,
  editWindowMs: null,
  minEditIntervalMs: 0,
  maxTextLength: 4_096,
  textFormat: 'plain',
  interactionButtons: true,
  reactions: true,
  typingIndicator: true,
  inboundFiles: true,
  outboundFiles: true,
  maxFileBytes: 50 * 1024 * 1024,
}

/** Constructor options for {@link FakeChatAdapter}. */
export interface FakeChatAdapterOptions {
  platform?: ChatPlatformId
  botId?: string
  capabilities?: Partial<ChatAdapterCapabilities> | undefined
}

/**
 * The fake adapter. `enqueue` resolves once the bridge sink has accepted the
 * event, giving tests a deterministic inbound barrier; every outbound call
 * appends to {@link FakeChatAdapter.transcript}.
 */
export class FakeChatAdapter implements ChatAdapter {
  readonly platform: ChatPlatformId
  readonly botId: string
  readonly capabilities: ChatAdapterCapabilities

  /** Every outbound call in order. */
  readonly transcript: FakeOutbound[] = []
  /** Programmable attachment sources by attachmentId. */
  readonly attachments = new Map<string, FakeAttachmentSource>()
  /** Programmable direct routes by userId; an explicit `undefined` models a user the platform cannot message first. */
  readonly directRoutes = new Map<string, ChatRoute | undefined>()

  private sink: ChatInboundSink | undefined
  private drain: Promise<unknown> = Promise.resolve()
  private nextMessageId = 1
  private stopRun: (() => void) | undefined
  private readonly failures = new Map<FakeOutboundKind, Error[]>()

  constructor(options: FakeChatAdapterOptions = {}) {
    this.platform = options.platform ?? 'fake'
    this.botId = options.botId ?? 'fake-bot'
    this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities }
  }

  /**
   * Capture the sink and wait for abort or {@link FakeChatAdapter.stop}, as a
   * real long-connection loop would. The sink is released when the loop ends.
   * @param sink - bridge-owned inbound sink.
   * @param signal - bridge-owned cancellation.
   */
  async run(sink: ChatInboundSink, signal: AbortSignal): Promise<void> {
    this.sink = sink
    try {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          signal.removeEventListener('abort', finish)
          this.stopRun = undefined
          resolve()
        }
        this.stopRun = finish
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    } finally {
      this.sink = undefined
    }
  }

  /** Idempotent teardown: ends a pending {@link FakeChatAdapter.run} loop. */
  stop(): Promise<void> {
    this.stopRun?.()
    return Promise.resolve()
  }

  /** Whether a `run` loop currently holds a sink. */
  get running(): boolean {
    return this.sink !== undefined
  }

  /**
   * Deliver one inbound event through the captured sink, serialized behind
   * earlier deliveries.
   * @param event - normalized platform event.
   * @returns resolution once the sink accepted the event.
   * @throws when no `run` loop holds a sink.
   */
  enqueue(event: ChatInbound): Promise<void> {
    const sink = this.sink
    if (sink === undefined) return Promise.reject(new Error('FakeChatAdapter: enqueue requires a running adapter'))
    const accepted = this.drain.then(() => sink.accept(event))
    this.drain = accepted.catch(() => undefined)
    return accepted
  }

  /**
   * Make the next call of one outbound operation reject with `error`.
   * @param kind - operation to fail.
   * @param error - rejection, typically a `ChatAdapterError`.
   */
  failNext(kind: FakeOutboundKind, error: Error): void {
    this.failures.set(kind, [...this.failures.get(kind) ?? [], error])
  }

  private fail(kind: FakeOutboundKind): Promise<void> | undefined {
    const queue = this.failures.get(kind)
    const error = queue?.shift()
    return error === undefined ? undefined : Promise.reject(error)
  }

  private ref(route: ChatRoute): SentRef {
    return { messageId: `fake-${String(this.nextMessageId++)}`, route }
  }

  /**
   * Record one text message.
   * @param route - target route.
   * @param message - outbound text.
   * @returns the recorded reference.
   */
  async send(route: ChatRoute, message: OutboundMessage): Promise<SentRef> {
    await this.fail('send')
    const ref = this.ref(route)
    this.transcript.push({ kind: 'send', route, message, ref })
    return ref
  }

  /**
   * Record one in-place edit.
   * @param ref - earlier send.
   * @param message - replacement text.
   */
  async edit(ref: SentRef, message: OutboundMessage): Promise<void> {
    await this.fail('edit')
    this.transcript.push({ kind: 'edit', ref, message })
  }

  /**
   * Record one platform-level delete.
   * @param ref - earlier send to remove.
   */
  async recall(ref: SentRef): Promise<void> {
    await this.fail('recall')
    this.transcript.push({ kind: 'recall', ref })
  }

  /**
   * Record one button prompt.
   * @param route - target route.
   * @param prompt - interaction prompt.
   * @returns the recorded card reference.
   */
  async sendInteraction(route: ChatRoute, prompt: InteractionPrompt): Promise<SentRef> {
    await this.fail('interaction')
    const ref = this.ref(route)
    this.transcript.push({ kind: 'interaction', route, prompt, ref })
    return ref
  }

  /**
   * Record one interaction settlement.
   * @param ref - earlier interaction.
   * @param state - terminal state to display.
   */
  async settleInteraction(ref: SentRef, state: InteractionSettlement): Promise<void> {
    await this.fail('settle')
    this.transcript.push({ kind: 'settle', ref, state })
  }

  /**
   * Record one file delivery.
   * @param route - target route.
   * @param file - outbound file.
   * @returns the recorded delivery reference.
   */
  async sendFile(route: ChatRoute, file: OutboundFile): Promise<SentRef> {
    await this.fail('file')
    const ref = this.ref(route)
    this.transcript.push({ kind: 'file', route, file, ref })
    return ref
  }

  /**
   * Serve one programmable attachment source as a stream.
   * @param ref - inbound attachment reference.
   * @param maxBytes - caller cap; larger sources reject.
   * @param signal - unused: fake streams complete immediately.
   * @returns the attachment stream and media type.
   */
  fetchAttachment(ref: ChatAttachmentRef, maxBytes: number, signal: AbortSignal): Promise<{ stream: ReadableStream; mediaType: string }> {
    signal.throwIfAborted()
    const source = this.attachments.get(ref.attachmentId)
    if (source === undefined) return Promise.reject(new Error(`FakeChatAdapter: no attachment source for ${ref.attachmentId}`))
    if (source.bytes.byteLength > maxBytes) {
      return Promise.reject(new Error(`FakeChatAdapter: attachment ${ref.attachmentId} exceeds ${String(maxBytes)} bytes`))
    }
    return Promise.resolve({ stream: new Blob([source.bytes]).stream(), mediaType: source.mediaType })
  }

  /**
   * Record one typing hint.
   * @param route - route to mark as typing.
   */
  async setTyping(route: ChatRoute): Promise<void> {
    await this.fail('typing')
    this.transcript.push({ kind: 'typing', route })
  }

  /**
   * Direct route for one user.
   * @param userId - platform user id.
   * @returns the programmed route, or a direct chat whose id is the user id.
   */
  directRoute(userId: string): ChatRoute | undefined {
    return this.directRoutes.has(userId) ? this.directRoutes.get(userId) : { kind: 'direct', chatId: userId }
  }
}

/** Plugin row config mounting one fake adapter. */
export interface Config {
  /** Fake platform id. */
  platform: string
  /** Fake bot instance id. */
  botId: string
  /** Capability overrides applied over {@link FAKE_CAPABILITIES}. */
  capabilities?: Partial<ChatAdapterCapabilities>
}

export const Config: z<Config> = z.object({
  platform: z.string().default('fake'),
  botId: z.string().default('fake-bot'),
  capabilities: z.object({
    groupChats: z.boolean(),
    threads: z.boolean(),
    editOutbound: z.boolean(),
    editWindowMs: z.union([z.number(), z.const(null)]),
    minEditIntervalMs: z.number(),
    maxTextLength: z.number(),
    textFormat: z.string(),
    interactionButtons: z.boolean(),
    reactions: z.boolean(),
    typingIndicator: z.boolean(),
    inboundFiles: z.boolean(),
    outboundFiles: z.boolean(),
    maxFileBytes: z.number(),
  }),
})

/** Stable Cordis plugin name. */
export const name = 'chat-adapter-fake'
/** Services required before the fake can register. */
export const inject = ['chatAdapters']

/**
 * Mount one fake adapter into `ctx.chatAdapters` for this fiber's lifetime.
 * @param ctx - plugin context owning the registration.
 * @param config - fake identity and capability overrides.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = new FakeChatAdapter(config)
  ctx.effect(() => ctx.chatAdapters.register(adapter))
}

/** Exhaustiveness guard for the closed {@link FakeOutbound} union. */
/* v8 ignore next 3 -- unreachable: the union is closed */
function assertNever(value: never): never {
  throw new Error(`unreachable transcript entry: ${JSON.stringify(value)}`)
}

/**
 * Render a transcript as deterministic markdown for golden files.
 * @param transcript - outbound calls in order.
 * @returns one block per call; message ids appear verbatim.
 */
export function renderTranscript(transcript: readonly FakeOutbound[]): string {
  const where = (route: ChatRoute): string => `${route.kind}:${route.chatId}${route.threadId === undefined ? '' : `#${route.threadId}`}`
  const lines = transcript.map((entry): string => {
    switch (entry.kind) {
      case 'send': return `- send ${entry.ref.messageId} → ${where(entry.route)}: ${JSON.stringify(entry.message.text)}`
      case 'edit': return `- edit ${entry.ref.messageId}: ${JSON.stringify(entry.message.text)}`
      case 'recall': return `- recall ${entry.ref.messageId}`
      case 'interaction': return `- interaction ${entry.ref.messageId} → ${where(entry.route)} [${entry.prompt.kind}] ${JSON.stringify(entry.prompt.body)} actions=${entry.prompt.actions.map(action => `${action.id}:${action.label}`).join('|')}`
      case 'settle': return `- settle ${entry.ref.messageId}: ${entry.state}`
      case 'file': return `- file ${entry.ref.messageId} → ${where(entry.route)}: ${entry.file.fileName} (${String(entry.file.bytes)} bytes)`
      case 'typing': return `- typing → ${where(entry.route)}`
      /* v8 ignore next -- FakeOutbound is a closed union */
      default: return assertNever(entry)
    }
  })
  return `${lines.join('\n')}\n`
}
