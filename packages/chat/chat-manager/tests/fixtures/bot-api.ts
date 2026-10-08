/** A scripted Telegram Bot API behind the adapter's transport seam: `getMe`, queued `getUpdates` batches, recorded sends. */

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>

/** One recorded Bot API request. */
export interface BotApiCall {
  method: string
  payload: Record<string, unknown>
  url: URL
}

/** The scripted Bot API. */
export class ScriptedBotApi {
  readonly calls: BotApiCall[] = []
  private readonly batches: unknown[][] = []
  /** Delivers a batch to the long poll that is parked right now. */
  private parked: ((batch: unknown[]) => void) | undefined

  /** Deliver one batch of updates to the parked long poll, or queue it for the next `getUpdates`. */
  pending(...updates: unknown[]): void {
    if (this.parked === undefined) this.batches.push(updates)
    else this.parked(updates)
  }

  /** @returns the calls of one Bot API method. */
  of(method: string): BotApiCall[] {
    return this.calls.filter(call => call.method === method)
  }

  readonly fetch: FetchLike = (input, init) => {
    const method = /\/bot[^/]+\/(.+)$/u.exec(input.pathname)?.[1]
    if (method === undefined) return Promise.reject(new Error(`unexpected URL ${input.href}`))
    const payload = JSON.parse(init.body as string) as Record<string, unknown>
    this.calls.push({ method, payload, url: input })
    const answer = (result: unknown): Promise<Response> => Promise.resolve(Response.json({ ok: true, result }))
    switch (method) {
      case 'getMe': return answer({ id: 777000, is_bot: true, first_name: 'Harni', username: 'HarniBot' })
      case 'getUpdates': {
        const batch = this.batches.shift()
        if (batch !== undefined) return answer(batch)
        // A long poll with nothing to deliver parks until a batch arrives or the adapter aborts it.
        return new Promise<Response>((resolve, reject) => {
          this.parked = (updates) => {
            this.parked = undefined
            resolve(Response.json({ ok: true, result: updates }))
          }
          init.signal?.addEventListener('abort', () => {
            this.parked = undefined
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      case 'sendMessage': return answer({ message_id: 100 + this.calls.length, chat: { id: payload.chat_id } })
      default: return answer(true)
    }
  }
}
