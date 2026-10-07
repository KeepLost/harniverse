/** A fake Bot API behind the adapter's transport seam: scripted answers, recorded calls, and a blocking long poll. */

import type { FetchLike } from '../../src/api.ts'

/** One recorded Bot API request. */
export interface ApiCall {
  method: string
  payload: Record<string, unknown>
  form?: FormData
  url: URL
}

type Answer =
  | { result: unknown }
  | { error: { status: number; error_code?: number; description: string; retry_after?: number } }
  | { raw: Response }
  | { throws: Error }

/** The scripted Bot API. */
export class FakeBotApi {
  readonly calls: ApiCall[] = []
  readonly fileRequests: URL[] = []
  private readonly scripts = new Map<string, Answer[]>()
  private readonly batches: unknown[][] = []
  files = new Map<string, {
    path: string
    size?: number
    body: Uint8Array | ReadableStream<Uint8Array> | null
    headers?: Record<string, string>
    status?: number
  }>()

  /** Queue the answers of one Bot API method; the last repeats. */
  script(method: string, ...answers: Answer[]): void {
    this.scripts.set(method, answers)
  }

  /** Queue one batch of updates for `getUpdates`. */
  pending(...updates: unknown[]): void {
    this.batches.push(updates)
  }

  /** @returns calls of one method. */
  of(method: string): ApiCall[] {
    return this.calls.filter(call => call.method === method)
  }

  private defaultResult(method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case 'getMe': return { id: 777000, is_bot: true, username: 'HarniBot' }
      case 'getUpdates': return this.batches.shift() ?? []
      case 'sendMessage':
      case 'sendDocument': return { message_id: 100 + this.calls.length, chat: { id: payload.chat_id } }
      case 'getFile': return { file_id: payload.file_id, file_path: this.files.get(String(payload.file_id))?.path ?? 'documents/file_1.bin', file_size: this.files.get(String(payload.file_id))?.size }
      default: return true
    }
  }

  readonly fetch: FetchLike = async (input, init) => {
    const match = /\/(?:file\/)?bot[^/]+\/(.+)$/.exec(input.pathname)
    if (match === null) throw new Error(`unexpected URL ${input.href}`)
    if (input.pathname.includes('/file/')) {
      this.fileRequests.push(input)
      const entry = [...this.files.values()].find(candidate => input.pathname.endsWith(candidate.path))
      if (entry === undefined) return new Response('missing', { status: 404 })
      return new Response(entry.body as BodyInit, { status: entry.status ?? 200, headers: entry.headers ?? {} })
    }
    const method = match[1]!
    const form = init.body instanceof FormData ? init.body : undefined
    const payload = form === undefined ? JSON.parse(init.body as string) as Record<string, unknown> : {}
    this.calls.push({ method, payload, url: input, ...form === undefined ? {} : { form } })
    const signal = init.signal
    if (method === 'getUpdates' && this.batches.length === 0 && this.scripts.get(method) === undefined) {
      // A long poll with nothing to deliver blocks until the caller aborts.
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    }
    const queue = this.scripts.get(method)
    const answer: Answer | undefined = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0]
    if (answer !== undefined && 'throws' in answer) throw answer.throws
    if (answer !== undefined && 'raw' in answer) return answer.raw
    if (answer !== undefined && 'error' in answer) {
      const { status, error_code: code, description, retry_after: retry } = answer.error
      return Response.json({
        ok: false,
        error_code: code ?? status,
        description,
        ...retry === undefined ? {} : { parameters: { retry_after: retry } },
      }, { status })
    }
    return Response.json({ ok: true, result: answer === undefined ? this.defaultResult(method, payload) : answer.result })
  }
}
