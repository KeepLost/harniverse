/**
 * Showcase integration: the real `web_fetch` tool + the real spill stack
 * (`dsh-spill-local` backend + `dsh-spill-policy` + the `artifact_read`
 * Consumer), exercised through `ctx.tools.execute()`. Proves the Agent Note's
 * default local-backend path — a large formatted fetch result is automatically
 * retained and spilled with NO tool-specific spill code, and the model-facing
 * text changes ONLY by the deliberate spill notice.
 *
 * The notice hands the model an OPAQUE locator, never a filesystem path: the
 * complete result is recoverable solely by passing that locator back to
 * `artifact_read`, so the storage backend stays unnamed in model-facing text.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const testToolSignal = new AbortController().signal
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-http'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import * as ToolResultArtifacts from '@deepseek-ai/dsh-tool-result-artifacts'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let testFetchPluginCounter = 0
let server: Server
let base: string
let handler: Handler
let spillRoot: string
let ctx: Context

const BODY = 'X'.repeat(4000) // formatted result is well over the policy cap
const MAX_INLINE_BYTES = 1000 // leaves room for a head/tail preview beside the notice
const ARTIFACT_PAGE_CHARS = 1000 // several pages for a ~4KB artifact: exercises cursor continuation

/** Route a public test hostname to the loopback fixture without weakening production URL policy. */
function loopbackFetchPlugin(targetPort: number): {
  name: string
  inject: string[]
  apply: (context: Context) => void
} {
  return {
    name: `test-web-fetch-spill-${++testFetchPluginCounter}`,
    inject: ['web'],
    apply: (context) => {
      context.web.registerFetchProvider(new WebFetchLocal.HttpFetchProvider({
        maxUrlLength: 2048,
        maxResponseBytes: 5_000_000,
        maxBodyChars: 500_000,
        timeoutMs: 30_000,
        maxRedirects: 0,
        userAgent: 'spill-test',
      }, {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        request: async (url, _address, options) => {
          const target = new URL(url)
          target.hostname = '127.0.0.1'
          target.port = String(targetPort)
          return await fetch(target, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'user-agent': options.userAgent },
            signal: options.signal,
          })
        },
      }))
    },
  }
}

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(BODY) }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://public.test:${(server.address() as AddressInfo).port}`
  spillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-web-'))

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebRuntime, { fetchProvider: WebFetchLocal.LOCAL_FETCH_PROVIDER_ID })
  // Provider cap generous so the tool returns a large formatted result; the
  // policy cap is what triggers the spill (the Agent Note's separation of concerns).
  await ctx.plugin(loopbackFetchPlugin((server.address() as AddressInfo).port))
  await ctx.plugin(LocalSpillStore, { root: spillRoot })
  await ctx.plugin(SpillPolicy, { maxInlineBytes: MAX_INLINE_BYTES })
  // The retrieval Consumer the spill notice sends the model to. Composing it
  // here is what makes the notice's promise testable end to end.
  await ctx.plugin(ToolResultArtifacts, { pageChars: ARTIFACT_PAGE_CHARS })
  await ctx.plugin(ToolWeb)
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  rmSync(spillRoot, { recursive: true, force: true })
})

/** A web_fetch call carrying a session owner (so the policy can scope the spill). */
function fetchCall(): Promise<{ isError: boolean; content: { type: string; text?: string }[] }> {
  const agent = { session: { header: { id: SessionId('web-sess') } } }
  const exec = { callId: CallId('call-1'), name: 'web_fetch', arguments: { url: base }, agent, signal: testToolSignal } as unknown as ToolExecution
  return ctx.tools.execute(exec)
}

/** One `artifact_read` page: the tool's accepted value, narrowed for assertions. */
interface ArtifactPage {
  isError: boolean
  value?: { text: string; nextCursor?: string }
}

/** One `artifact_read` call, executed through the registry like any model call. */
async function artifactRead(locator: string, cursor?: string): Promise<ArtifactPage> {
  const exec = {
    callId: CallId(`read-${locator}-${cursor ?? 'first'}`),
    name: 'artifact_read',
    arguments: { locator, ...cursor === undefined ? {} : { cursor } },
    signal: testToolSignal,
  } as unknown as ToolExecution
  // Narrow through the tool's public JSON boundary: the registry validated
  // `value` against `artifact_read`'s declared output schema, which is this shape.
  const result: unknown = await ctx.tools.execute(exec)
  return result as ArtifactPage
}

/**
 * Recover the complete artifact the way the notice instructs: hand the locator
 * to `artifact_read` unchanged and follow each returned cursor. This is the only
 * supported retrieval path — the model never learns a filesystem path.
 */
async function readWholeArtifact(locator: string): Promise<{ text: string; pages: number }> {
  let text = ''
  let pages = 0
  let cursor: string | undefined
  for (;;) {
    const page = await artifactRead(locator, cursor)
    expect(page.isError).toBe(false)
    text += page.value!.text
    pages++
    cursor = page.value!.nextCursor
    if (cursor === undefined) return { text, pages }
  }
}

describe('web_fetch spill showcase', () => {
  it('spills a large formatted result and returns a preview + spill locator', async () => {
    const out = await fetchCall()
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.text).join('')

    // Model-facing text is a preview + notice within the cap, NOT the full body.
    expect(text.length).toBeLessThan(BODY.length)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_BYTES)
    expect(text).toContain(`Fetched ${base}`) // the head of the formatted result survives
    expect(text).toContain('Full formatted result stored at:')
    expect(text).toContain('Pass this locator unchanged to the configured artifact reader.')

    const match = /stored at: (\S+?)\. Pass this locator unchanged/.exec(text)
    expect(match).not.toBeNull()
    const locator = match![1]!
    // The notice carries an OPAQUE locator, not a filesystem path: the storage
    // backend must stay unnamed in model-facing text, so a model cannot reach
    // the artifact with `read`/`grep` and no path escapes the spill root.
    expect(locator).not.toContain(spillRoot)
    expect(isAbsolute(locator)).toBe(false)

    // The artifact holds the FULL formatted result, recovered only through
    // `artifact_read`'s bounded paging. The provider cap was generous, so the
    // tool did not truncate: header + the complete body, far larger than the
    // preview. More than one page proves cursor continuation actually ran.
    const saved = await readWholeArtifact(locator)
    expect(saved.pages).toBeGreaterThan(1)
    expect(saved.text).toContain('(HTTP 200)')
    expect(saved.text).toContain(BODY)
    expect(saved.text.length).toBeGreaterThan(text.length)
  })

  it('refuses a locator the backend did not issue', async () => {
    const out = await fetchCall()
    const text = out.content.map(b => b.text).join('')
    const locator = /stored at: (\S+?)\. Pass this locator unchanged/.exec(text)![1]!

    // Opacity is enforced, not merely advertised: a locator assembled by hand —
    // here by traversing out of the issued one — is refused rather than resolved
    // against the spill root.
    const escaped = await artifactRead(`${locator}/../escape.txt`)
    expect(escaped.isError).toBe(true)
    expect(JSON.stringify(escaped)).toContain('invalid local spill locator')
  })
})
