/**
 * Outbound rendering: text splitting, the throttled editable stream, and the
 * small text helpers the bridge composes replies from.
 *
 * `splitMessageText` and `EditableStream` are ported from dsh-im
 * (`src/channels/shared/editable-message-stream.mjs`), MIT License,
 * Copyright (c) 2026 xmanrui; see THIRD_PARTY_NOTICES.md.
 * @module @deepseek-ai/dsh-chat-bridge/render
 */

import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'

/**
 * Split text into chunks of at most `limit` characters, preferring line breaks and then spaces.
 * @param value - text to split; surrounding whitespace is dropped.
 * @param limit - maximum chunk length.
 * @returns non-empty trimmed chunks, or none for blank input.
 */
export function splitMessageText(value: string, limit: number): string[] {
  const text = value.trim()
  if (text === '') return []
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf(' ', limit)
    if (cut < Math.floor(limit * 0.55)) cut = limit
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }
  chunks.push(remaining)
  return chunks
}

/** Operations the stream drives; the bridge binds them to one adapter route. */
export interface StreamDeps {
  /** Send the first message. */
  create(text: string): Promise<void>
  /** Replace the first message's text. */
  edit(text: string): Promise<void>
  /** Send one overflow chunk as a new message. */
  sendRemainder(text: string): Promise<void>
  warn(message: string, error?: unknown): void
}

/** Stream options. */
export interface StreamOptions {
  /** Placeholder shown until the first update. */
  initialText: string
  /** Platform text limit; the first chunk stays editable and the rest overflow. */
  limit: number
  /** Minimum spacing between edits. */
  intervalMs: number
}

/**
 * One streamed reply: a placeholder message edited in place at most once per
 * interval, finished with the complete text split at the platform limit. A
 * rate-limited edit keeps its text and retries after the platform's hint.
 */
export class EditableStream {
  private pending: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | undefined
  private closed = false
  private lastSent: string
  private resumeAt = 0

  constructor(private readonly deps: StreamDeps, private readonly options: StreamOptions) {
    this.lastSent = options.initialText
  }

  /** Send the placeholder message. */
  async start(): Promise<void> {
    await this.deps.create(this.options.initialText)
  }

  /**
   * Record the latest full text; an edit follows within the interval.
   * @param text - the complete text so far.
   */
  update(text: string): void {
    if (this.closed || text.trim() === '') return
    this.pending = text
    this.schedule()
  }

  /**
   * Flush the final text: edit the first chunk and send the rest as new messages.
   * @param text - the complete final text.
   */
  async finish(text: string): Promise<void> {
    this.closed = true
    this.clearTimer()
    this.pending = undefined
    await this.inFlight
    const chunks = splitMessageText(text, this.options.limit)
    const first = chunks[0] ?? ''
    if (first !== '' && first !== this.lastSent) await this.deps.edit(first)
    this.lastSent = first
    for (const chunk of chunks.slice(1)) await this.deps.sendRemainder(chunk)
  }

  /** Drop pending edits without sending anything. */
  cancel(): void {
    this.closed = true
    this.pending = undefined
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.closed || this.timer !== undefined || this.inFlight !== undefined || this.pending === undefined) return
    const delay = Math.max(this.options.intervalMs, this.resumeAt - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      const text = this.pending
      this.pending = undefined
      /* v8 ignore next -- schedule() runs only with pending text and every clear also clears the timer */
      if (text === undefined) return
      // update() drops blank text, so a pending text always yields a first chunk.
      const next = splitMessageText(text, this.options.limit)[0]
      if (next === undefined || next === this.lastSent) return
      this.inFlight = this.deps.edit(next).then(() => { this.lastSent = next }, (error: unknown) => {
        if (error instanceof ChatAdapterError && error.code === 'rate-limited') {
          this.resumeAt = Date.now() + (error.retryAfterMs ?? 0)
          this.pending ??= text
        } else {
          this.deps.warn('streamed message update failed', error)
        }
      }).finally(() => {
        this.inFlight = undefined
        this.schedule()
      })
    }, delay)
    this.timer.unref()
  }
}

/**
 * Prefix a group prompt with its sender so the model can tell speakers apart.
 * @param platform - platform id.
 * @param displayName - the sender's display name or id.
 * @param text - the prompt text.
 * @returns `[platform·name] text` with the name sanitized.
 */
export function withSenderPrefix(platform: string, displayName: string, text: string): string {
  const name = displayName.replace(/[\][\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
  return `[${platform}·${name === '' ? 'unknown' : name}] ${text}`
}

/**
 * Shorten text to at most `max` characters.
 * @param text - input text.
 * @param max - maximum length including the ellipsis.
 * @returns the text, cut with a trailing `…` when longer.
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
