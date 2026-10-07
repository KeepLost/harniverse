/** A fake Feishu Open API behind the transport seam: scripted answers and recorded calls. */

import type { FetchLike } from '../../src/runtime.ts'

/** One recorded request. */
export interface OpenCall {
  method: string
  path: string
  query: Record<string, string>
  headers: Headers
  json?: unknown
  form?: FormData
}

type Answer =
  | { data?: unknown; body?: Record<string, unknown>; code?: number; msg?: string; status?: number; headers?: Record<string, string> }
  | { raw: Response }
  | { throws: Error }

/** The scripted Open API. */
export class FakeOpenApi {
  readonly calls: OpenCall[] = []
  private readonly scripts = new Map<string, Answer[]>()
  tokens = 0
  resources = new Map<string, { body: Uint8Array | ReadableStream<Uint8Array> | null; headers?: Record<string, string> }>()

  /** Queue answers for `METHOD /path`; the last repeats. */
  script(key: string, ...answers: Answer[]): void {
    this.scripts.set(key, answers)
  }

  /** @returns calls whose path equals or ends with `path`. */
  to(path: string): OpenCall[] {
    return this.calls.filter(call => call.path === path)
  }

  readonly fetch: FetchLike = async (input, init) => {
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    const query = Object.fromEntries(input.searchParams)
    const form = init.body instanceof FormData ? init.body : undefined
    const json = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    this.calls.push({
      method, path: input.pathname, query, headers,
      ...json === undefined ? {} : { json },
      ...form === undefined ? {} : { form },
    })
    const key = `${method} ${input.pathname}`
    const queue = this.scripts.get(key)
    const answer: Answer | undefined = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0]
    if (answer !== undefined && 'throws' in answer) throw answer.throws
    if (answer !== undefined && 'raw' in answer) return answer.raw
    if (answer !== undefined) {
      return Response.json({ code: answer.code ?? 0, msg: answer.msg ?? 'ok', ...answer.data === undefined ? {} : { data: answer.data }, ...answer.body ?? {} }, { status: answer.status ?? 200, headers: answer.headers ?? {} })
    }
    return this.defaults(method, input, json)
  }

  private defaults(method: string, input: URL, json: unknown): Response {
    const path = input.pathname
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      this.tokens += 1
      return Response.json({ code: 0, msg: 'ok', tenant_access_token: `t-${String(this.tokens)}`, expire: 7_200 })
    }
    if (path === '/open-apis/bot/v3/info') return Response.json({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } })
    if (method === 'POST' && (path === '/open-apis/im/v1/messages' || path.endsWith('/reply'))) {
      return Response.json({ code: 0, msg: 'ok', data: { message_id: `om_sent_${String(this.calls.length)}` }, echoed: json })
    }
    if (method === 'POST' && path === '/open-apis/im/v1/files') return Response.json({ code: 0, msg: 'ok', data: { file_key: 'file_key_1' } })
    if (path.includes('/resources/')) {
      const key = decodeURIComponent(path.split('/').at(-1)!)
      const resource = this.resources.get(key)
      return resource === undefined ? Response.json({ code: 234001, msg: 'not found' }, { status: 404 }) : new Response(resource.body as BodyInit, { headers: resource.headers ?? {} })
    }
    return Response.json({ code: 0, msg: 'ok', data: {} })
  }
}
