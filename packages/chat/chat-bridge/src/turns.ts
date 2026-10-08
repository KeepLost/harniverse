/**
 * Turn rendering: folds a bridge session's durable events into one streamed
 * reply per IM-originated turn, and forwards files the model presented.
 * @module @deepseek-ai/dsh-chat-bridge/turns
 */

import { ChatAdapterError, type ChatAdapter, type SentRef } from '@deepseek-ai/dsh-chat-adapter'
import type { MuxSessionEvent } from '@deepseek-ai/dsh-chat-harniverse-client'
import type { Config } from './members.ts'
import { checkDeliverable } from './files.ts'
import { routeOf, type LiveSession, type Origin, type Turn } from './live.ts'
import type { Log, Messenger } from './messenger.ts'
import { EditableStream } from './render.ts'

/** Placeholder shown while the model works. */
const PLACEHOLDER = '...'

type Dict = Record<string, unknown>

/**
 * The last path segment of a presented path, for the user-facing notice.
 * Splits on both separators: the path is model-supplied and may be a Windows
 * absolute path (`C:\\dir\\f.txt`) or a POSIX one, independent of the host.
 * @param path - the path as the model presented it.
 * @returns the final segment.
 */
function noticeName(path: string): string | undefined {
  return path.split(/[\\/]/).at(-1)
}

function dict(value: unknown): Dict {
  return typeof value === 'object' && value !== null ? value as Dict : {}
}

/**
 * The final chat text of a turn.
 * @param text - assistant text accumulated during the turn.
 * @param reason - the durable `turn/end` reason; unknown kinds are shown as ended.
 * @returns the message to leave in the chat.
 */
export function finalText(text: string, reason: unknown): string {
  const body = text.trim()
  const kind = dict(reason).kind
  const note = (label: string): string => (body === '' ? label : `${body}\n\n${label}`)
  switch (kind) {
    case 'completed': return body === '' ? '(no text reply)' : body
    case 'aborted': return note('[stopped]')
    case 'blocked': return note('[blocked]')
    case 'interrupted': return note('[interrupted]')
    case 'max-tokens': return note('[output limit reached]')
    case 'error': {
      const message = dict(dict(reason).error).message
      return note(`[error] ${typeof message === 'string' ? message : 'the turn failed'}`)
    }
    default: return note('[ended]')
  }
}

/** Renders session events for IM-originated turns. */
export class TurnRenderer {
  constructor(
    private readonly config: Pick<Config, 'streamIntervalMs' | 'outbound'>,
    private readonly messenger: Messenger,
    private readonly log: Log,
  ) {}

  /**
   * Apply one durable session event.
   * @param live - the bridge session the event belongs to.
   * @param event - the event; other kinds than the ones below are ignored.
   */
  async apply(live: LiveSession, event: MuxSessionEvent): Promise<void> {
    const data = dict(event.data)
    switch (event.type) {
      case 'turn/start':
        live.turn = { number: Number(data.turn), text: '', separate: false, plain: false }
        return
      case 'user/message': return this.claim(live, dict(data.source).rpcId)
      case 'step/start':
        if (live.turn !== undefined && live.turn.text !== '') live.turn.separate = true
        return
      case 'assistant/chunk':
        this.text(live.turn, dict(data.chunk))
        return
      case 'tool/call':
        live.toolCalls.set(String(data.callId), { name: String(data.name), arguments: String(data.arguments) })
        if (live.turn !== undefined) {
          live.turn.tool = String(data.name)
          this.refresh(live.turn)
        }
        return
      case 'tool/result':
        live.toolCalls.delete(String(data.callId))
        if (live.turn !== undefined) {
          delete live.turn.tool
          this.refresh(live.turn)
        }
        return
      case 'deliverables/presented': return this.deliver(live, data.files)
      case 'turn/end': return this.end(live, data.reason)
      default:
    }
  }

  private async claim(live: LiveSession, rpcId: unknown): Promise<void> {
    const turn = live.turn
    const origin = typeof rpcId === 'string' ? live.prompts.get(rpcId) : undefined
    if (origin === undefined || turn === undefined) return
    live.prompts.delete(origin.rpcId)
    if (turn.origin !== undefined) return
    turn.origin = origin
    await this.open(turn, origin)
  }

  private async open(turn: Turn, origin: Origin): Promise<void> {
    const adapter = this.messenger.adapterFor(origin)
    const caps = adapter?.capabilities
    if (adapter === undefined || caps === undefined) {
      turn.plain = true
      return
    }
    void adapter.setTyping?.(origin.route).catch(() => undefined)
    if (!caps.editOutbound || adapter.edit === undefined) {
      turn.plain = true
      return
    }
    const editMessage = adapter.edit.bind(adapter)
    let ref: SentRef | undefined
    const edit = async (text: string): Promise<void> => {
      const target = ref
      /* v8 ignore next -- EditableStream edits only after create resolved */
      if (target === undefined) return
      try {
        await editMessage(target, { text })
      } catch (error) {
        if (!(error instanceof ChatAdapterError) || error.code !== 'edit-failed') throw error
        ref = await adapter.send(origin.route, { text })
      }
    }
    const stream = new EditableStream({
      create: async (text) => { ref = await adapter.send(origin.route, { text }) },
      edit,
      sendRemainder: async (text) => { await adapter.send(origin.route, { text }) },
      warn: (message, error) => { this.log.warn(message, error) },
    }, {
      initialText: PLACEHOLDER,
      limit: caps.maxTextLength,
      intervalMs: Math.max(this.config.streamIntervalMs, caps.minEditIntervalMs),
    })
    try {
      await stream.start()
      turn.stream = stream
    } catch (error) {
      this.log.warn('starting the streamed reply failed', error)
      turn.plain = true
    }
  }

  private text(turn: Turn | undefined, chunk: Dict): void {
    if (turn === undefined || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
    turn.text += turn.separate ? `\n\n${chunk.text}` : chunk.text
    turn.separate = false
    this.refresh(turn)
  }

  private refresh(turn: Turn): void {
    if (turn.stream === undefined) return
    const tool = turn.tool === undefined ? '' : `[tool: ${turn.tool}]`
    turn.stream.update(turn.text === '' ? tool : tool === '' ? turn.text : `${turn.text}\n\n${tool}`)
  }

  private async end(live: LiveSession, reason: unknown): Promise<void> {
    const turn = live.turn
    delete live.turn
    const origin = turn?.origin
    if (turn === undefined || origin === undefined) return
    const text = finalText(turn.text, reason)
    const adapter = this.messenger.adapterFor(origin)
    if (adapter === undefined) return
    if (turn.stream !== undefined) {
      try {
        await turn.stream.finish(text)
        return
      } catch (error) {
        this.log.warn('finishing the streamed reply failed; sending it as a new message', error)
      }
    }
    await this.messenger.reply(adapter, origin.route, text)
  }

  private async deliver(live: LiveSession, files: unknown): Promise<void> {
    const origin = live.turn?.origin
    const target = origin ?? live.record
    const adapter = this.messenger.adapterFor(target)
    if (adapter === undefined || !Array.isArray(files)) return
    const route = origin?.route ?? routeOf(live.record)
    await this.sendFiles(adapter, route, live, files.map(file => String(dict(file).path)))
  }

  private async sendFiles(adapter: ChatAdapter, route: Origin['route'], live: LiveSession, paths: readonly string[]): Promise<void> {
    if (live.record.remoteHost !== undefined) {
      await this.messenger.reply(adapter, route, 'Files from a remote host are not delivered to chat.')
      return
    }
    if (!adapter.capabilities.outboundFiles || adapter.sendFile === undefined) {
      await this.messenger.reply(adapter, route, 'This platform cannot receive files.')
      return
    }
    const cap = Math.min(adapter.capabilities.maxFileBytes, this.config.outbound.maxFileBytes)
    for (const path of paths) {
      const checked = await checkDeliverable(live.record.cwd, path, cap)
      if (!checked.ok) {
        this.log.warn(`not delivering ${JSON.stringify(path)}: ${checked.reason}`)
        await this.messenger.reply(adapter, route, `Not sending ${JSON.stringify(noticeName(path))}: ${checked.reason}.`)
        continue
      }
      try {
        await adapter.sendFile(route, checked.file)
      } catch (error) {
        this.log.warn(`sending ${checked.file.fileName} failed`, error)
        const tooLarge = error instanceof ChatAdapterError && error.code === 'file-too-large'
        await this.messenger.reply(adapter, route, tooLarge ? `${checked.file.fileName} is larger than this platform accepts.` : `Sending ${checked.file.fileName} failed.`)
      }
    }
  }
}
