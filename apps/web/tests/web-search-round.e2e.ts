// Web e2e scenario for an explicit search-enabled overlay. A real browser
// drives `web_search`; the model stream is replayed while the real DeepSeek
// provider calls a deterministic local Anthropic-compatible endpoint through
// the real credentials service.
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WEB_SEARCH_MAX_RESULTS } from '@deepseek-ai/dsh-tool-web'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/web-search-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/web-search-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/web-search-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const QUERIES = ['DeepSeek Harness snapshot search', 'Harniverse plugin snapshot search'] as const
const PROMPT = `Use web_search to search exactly "${QUERIES[0]}" and exactly "${QUERIES[1]}". Then reply exactly SEARCH_DONE and stop.`
const SEARCH_CREDENTIAL_REF = credentialRef('DSH_WEB_SEARCH_E2E_KEY')
const SEARCH_CREDENTIAL = 'snapshot-search-key'

/**
 * Provider results the double returns, exceeding the shipped `searchMaxResults`
 * so the seam's cap and the card's scroll container are both exercised. Each row
 * carries a title, a snippet, and a date, so 8 kept rows exceed the `.sources`
 * 320px max-height.
 */
const PROVIDER_RESULT_COUNT = 12

/** One provider result's URL, by query and 1-based provider order. Rank one is shared. */
function resultUrl(queryIndex: number, ordinal: number): string {
  return ordinal === 1
    ? 'https://docs.example.test/search/shared'
    : `https://docs.example.test/search/${queryIndex + 1}-${ordinal}`
}

/** One provider result's title, by query and 1-based provider order. */
function resultTitle(queryIndex: number, ordinal: number): string {
  return ordinal === 1 ? 'Snapshot Shared Search Result' : `Snapshot Search Result ${queryIndex + 1}-${ordinal}`
}

/** One provider result's citation excerpt, by query and 1-based provider order. */
function resultSnippet(queryIndex: number, ordinal: number): string {
  return `Snapshot search excerpt ${queryIndex + 1}-${ordinal}: the harness replays this source list from a local endpoint.`
}

/** One provider result's `page_age`, by 1-based provider order (July 2026 days 01..12). */
function resultPageAge(ordinal: number): string {
  return `2026-07-${String(ordinal).padStart(2, '0')}`
}

/** The 1-based provider ordinals, in provider order. */
const RESULT_ORDINALS = Array.from({ length: PROVIDER_RESULT_COUNT }, (_value, index) => index + 1)

/** The expected merged source order under the combined result cap. */
function mergedResultOrder(maxResults: number): { queryIndex: number; ordinal: number }[] {
  const seen = new Set<string>()
  const merged: { queryIndex: number; ordinal: number }[] = []
  for (const ordinal of RESULT_ORDINALS) {
    for (const queryIndex of QUERIES.keys()) {
      const candidate = { queryIndex, ordinal }
      const url = resultUrl(candidate.queryIndex, candidate.ordinal)
      if (seen.has(url)) continue
      seen.add(url)
      merged.push(candidate)
      if (merged.length === maxResults) return merged
    }
  }
  return merged
}

const MERGED_RESULTS = mergedResultOrder(WEB_SEARCH_MAX_RESULTS)

interface CapturedSearchRequest {
  path: string
  apiKey: string | undefined
  authorization: string | undefined
  body: unknown
}

/** Start the deterministic DeepSeek Messages double used by the real provider. */
async function startSearchServer(captured: CapturedSearchRequest[]): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const requestBody = JSON.parse(body) as unknown
      captured.push({
        path: request.url ?? '',
        apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
        authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
        body: requestBody,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      const bodyText = JSON.stringify(requestBody)
      const queryIndex = QUERIES.findIndex(query => bodyText.includes(query))
      if (queryIndex < 0) throw new Error('provider request did not contain a known query')
      response.end(JSON.stringify({
        content: [
          {
            type: 'text',
            text: `Found ${PROVIDER_RESULT_COUNT} sources for ${QUERIES[queryIndex]}.`,
            citations: RESULT_ORDINALS.map(ordinal => ({
              type: 'web_search_result_location',
              url: resultUrl(queryIndex, ordinal),
              cited_text: resultSnippet(queryIndex, ordinal),
            })),
          },
          {
            type: 'web_search_tool_result',
            content: RESULT_ORDINALS.map(ordinal => ({
              type: 'web_search_result',
              url: resultUrl(queryIndex, ordinal),
              title: resultTitle(queryIndex, ordinal),
              page_age: resultPageAge(ordinal),
            })),
          },
        ],
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

/** Start a deterministic JSON provider double for the Exa/Perplexity assembled rounds. */
async function startJsonSearchServer(
  captured: CapturedSearchRequest[],
  responseBody: unknown,
): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      captured.push({
        path: request.url ?? '',
        apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
        authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
        body: JSON.parse(body) as unknown,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseBody))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

describe('web e2e: opt-in DeepSeek web search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let searchServer: Server | undefined
  let searchBaseURL: string
  let tripwire: ReturnType<typeof watchConsole>
  const searchRequests: CapturedSearchRequest[] = []
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    const search = await startSearchServer(searchRequests)
    searchServer = search.server
    searchBaseURL = search.baseURL
    scaffold = await launchWebScaffold({
      deepSeekSearch: {
        baseURL: search.baseURL,
        apiKeyEnv: SEARCH_CREDENTIAL_REF,
      },
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    await scaffold.ctx.credentials.set(SEARCH_CREDENTIAL_REF, SEARCH_CREDENTIAL)
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      if (searchServer === undefined) {
        resolve()
        return
      }
      searchServer.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('drives the recorded search to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-drive'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('uses the real provider and persists the capped structured result', () => {
    expect(searchRequests).toHaveLength(2)
    const orderedRequests = [...searchRequests].sort((left, right) => JSON.stringify(left.body).localeCompare(JSON.stringify(right.body)))
    for (const [index, request] of orderedRequests.entries()) {
      expect(request).toMatchObject({
        path: '/messages',
        apiKey: SEARCH_CREDENTIAL,
        body: {
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `Perform a web search for the query: ${QUERIES[index]}` }],
          }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        },
      })
    }

    const auxiliaryRequests = sessionEvents.filter(
      (event): event is Extract<SessionEvent, { type: 'web/deepseek-search-llm-request' }> =>
        event.type === 'web/deepseek-search-llm-request',
    )
    expect(auxiliaryRequests).toHaveLength(2)
    const orderedAuxiliaryRequests = [...auxiliaryRequests].sort((left, right) => (
      JSON.stringify(left.data.body).localeCompare(JSON.stringify(right.data.body))
    ))
    expect(orderedAuxiliaryRequests.map(event => event.data.body)).toEqual(orderedRequests.map(request => request.body))
    expect(auxiliaryRequests.every(event => event.data.endpoint === `${searchBaseURL}/messages` && event.data.apiVersion === '2023-06-01')).toBe(true)

    const searchCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'web_search',
    )
    if (searchCall === undefined) throw new Error('the replayed turn did not call web_search')
    expect(JSON.parse(searchCall.data.arguments)).toEqual({ queries: [...QUERIES] })
    const searchResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === searchCall.data.callId,
    )
    if (searchResult === undefined) throw new Error('web_search produced no durable result')
    const content = searchResult.data.message.content[0]
    expect(content.isError).toBe(false)
    const rendered = content.content.filter(block => block.type === 'text').map(block => block.text).join('')
    for (const { queryIndex, ordinal } of MERGED_RESULTS) {
      expect(rendered).toContain(`[${resultTitle(queryIndex, ordinal)}](${resultUrl(queryIndex, ordinal)})`)
    }
    for (const ordinal of RESULT_ORDINALS) {
      for (const queryIndex of QUERIES.keys()) {
        const url = resultUrl(queryIndex, ordinal)
        if (!MERGED_RESULTS.some(result => resultUrl(result.queryIndex, result.ordinal) === url)) expect(rendered).not.toContain(url)
      }
    }
    expect(rendered.split(resultUrl(0, 1)).length).toBe(2)
    expect(rendered).toContain(
      `(Showing the first ${WEB_SEARCH_MAX_RESULTS} sources. Refine the query for more.)`,
    )
    expect(searchResult.data.meta).toMatchObject({
      sources: MERGED_RESULTS.map(({ queryIndex, ordinal }) => ({
        url: resultUrl(queryIndex, ordinal),
        title: resultTitle(queryIndex, ordinal),
        snippet: resultSnippet(queryIndex, ordinal),
        publishedAt: resultPageAge(ordinal),
      })),
      truncated: true,
    })
  })

  it.skipIf(MODE === 'record')('matches the settled search card aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-aria'))
    await expect.poll(() => page.getByText('SEARCH_DONE', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await page.locator('[data-tool="web_search"]').waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('scrolls the capped source list inside the fixed-height container', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-sources-scroll'))
    const row = page.locator('[data-tool="web_search"] [data-expandable]').first()
    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')

    const card = page.locator('[data-web="search"]')
    const sources = card.locator('ol')
    await sources.waitFor({ timeout: 10_000 })
    // The card draws exactly the sources the model saw: the seam's cap, not the
    // provider's list length.
    expect(await sources.locator('li').count()).toBe(WEB_SEARCH_MAX_RESULTS)
    // The list is complete in the DOM, so the card carries no expand control.
    expect(await card.locator('button').count()).toBe(0)
    expect(await card.getByText('来源列表已截断').isVisible()).toBe(true)

    const geometry = await sources.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        maxHeight: computed.maxHeight,
        overflowY: computed.overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }
    })
    expect(geometry.maxHeight).toBe('320px')
    expect(geometry.overflowY).toBe('auto')
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  })

  it.skipIf(MODE === 'record')('reserves marker room a scroll container cannot clip back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-marker-room'))
    // `overflow-y: auto` clips inline-start overflow with no way to scroll it
    // back, and markers are right-aligned to the content edge, so a marker wider
    // than `padding-left` silently loses its leading digits. `searchMaxResults`
    // is an unbounded positive integer, so measure the widest three-digit marker
    // in the list's own font and require the shipped padding to hold it.
    const marker = await page.locator('[data-web="search"] ol').evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit'
      probe.textContent = '999. '
      element.append(probe)
      const widest = probe.getBoundingClientRect().width
      probe.remove()
      return { widest, paddingLeft: parseFloat(getComputedStyle(element).paddingLeft) }
    })
    expect(marker.paddingLeft).toBeGreaterThanOrEqual(marker.widest)
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})

const ADDITIONAL_PROVIDER_SCENARIOS = [
  {
    provider: 'exa' as const,
    credentialRef: credentialRef('DSH_WEB_SEARCH_EXA_E2E_KEY'),
    credential: 'snapshot-exa-key',
    response: {
      results: [
        {
          url: 'https://exa.example.test/primary',
          title: 'Exa Primary',
          highlights: ['  ', 'Exa highlight from the deterministic local response.'],
          publishedDate: '2026-08-01',
        },
        {
          url: 'https://exa.example.test/no-highlight',
          title: 'Exa result without a portable snippet',
        },
      ],
    },
    expectedPath: '/search',
    expectedBody: QUERIES.map(query => ({
      query,
      type: 'neural',
      contents: { highlights: { highlightsPerUrl: 2 } },
      numResults: WEB_SEARCH_MAX_RESULTS,
    })),
    expectedText: [
      'Sources:',
      '- [Exa Primary](https://exa.example.test/primary) — Exa highlight from the deterministic local response. (2026-08-01)',
      '- [Exa result without a portable snippet](https://exa.example.test/no-highlight)',
      '',
      'Cite the relevant URLs above as markdown links in your answer.',
    ].join('\n'),
    expectedMeta: {
      sources: [
        {
          url: 'https://exa.example.test/primary',
          title: 'Exa Primary',
          snippet: 'Exa highlight from the deterministic local response.',
          publishedAt: '2026-08-01',
        },
        { url: 'https://exa.example.test/no-highlight', title: 'Exa result without a portable snippet' },
      ],
      truncated: false,
    },
  },
  {
    provider: 'perplexity' as const,
    credentialRef: credentialRef('DSH_WEB_SEARCH_PERPLEXITY_E2E_KEY'),
    credential: 'snapshot-perplexity-key',
    response: {
      choices: [{ message: { content: 'Perplexity synthesized answer from the local response.' } }],
      search_results: [
        {
          url: 'https://perplexity.example.test/answer',
          title: 'Perplexity Answer Source',
          snippet: 'Perplexity returns generated content and a structured source.',
          date: '2026-08-02',
        },
      ],
    },
    expectedPath: '/chat/completions',
    expectedBody: QUERIES.map(query => ({
      model: 'sonar-test',
      max_tokens: 321,
      messages: [{ role: 'user', content: query }],
      search_recency_filter: 'week',
    })),
    expectedText: [
      `### ${QUERIES[0]}`,
      '',
      'Perplexity synthesized answer from the local response.',
      '',
      `### ${QUERIES[1]}`,
      '',
      'Perplexity synthesized answer from the local response.',
      '',
      'Sources:',
      '- [Perplexity Answer Source](https://perplexity.example.test/answer) — Perplexity returns generated content and a structured source. (2026-08-02)',
      '',
      'Cite the relevant URLs above as markdown links in your answer.',
    ].join('\n'),
    expectedMeta: {
      sources: [{
        url: 'https://perplexity.example.test/answer',
        title: 'Perplexity Answer Source',
        snippet: 'Perplexity returns generated content and a structured source.',
        publishedAt: '2026-08-02',
      }],
      truncated: false,
      answer: `### ${QUERIES[0]}\n\nPerplexity synthesized answer from the local response.\n\n### ${QUERIES[1]}\n\nPerplexity synthesized answer from the local response.`,
    },
  },
]

describe.skipIf(MODE === 'record').each(ADDITIONAL_PROVIDER_SCENARIOS)(
  'web e2e: opt-in $provider search composition',
  (scenario) => {
    let scaffold: WebScaffold
    let browser: Browser
    let page: Page
    let searchServer: Server | undefined
    let tripwire: ReturnType<typeof watchConsole>
    const searchRequests: CapturedSearchRequest[] = []
    const sessionEvents: SessionEvent[] = []

    beforeAll(async () => {
      const search = await startJsonSearchServer(searchRequests, scenario.response)
      searchServer = search.server
      scaffold = await launchWebScaffold({
        webSearch: {
          provider: scenario.provider,
          baseURL: search.baseURL,
          apiKeyEnv: scenario.credentialRef,
        },
        replayFixture: FIXTURE,
        paceMs: 15,
      })
      await scaffold.ctx.credentials.set(scenario.credentialRef, scenario.credential)
      scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      tripwire = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
    }, 120_000)

    afterAll(async () => {
      await browser?.close()
      await scaffold?.close()
      await new Promise<void>((resolve, reject) => {
        if (searchServer === undefined) {
          resolve()
          return
        }
        searchServer.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    })

    it('pins the provider wire request and durable model-visible result', async () => {
      onTestFailed(() => saveFailureShot(page, `web-e2e-search-${scenario.provider}`))
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
      const input = page.locator('textarea').first()
      await input.waitFor({ timeout: 10_000 })
      const settled = scaffold.whenTurnSettled()
      await input.fill(PROMPT)
      await input.press('Enter')
      await settled

      expect(searchRequests).toHaveLength(2)
      const orderedRequests = [...searchRequests].sort((left, right) => (
        JSON.stringify(left.body).localeCompare(JSON.stringify(right.body))
      ))
      expect(orderedRequests).toEqual(QUERIES.map((_, index) => ({
        path: scenario.expectedPath,
        apiKey: undefined,
        authorization: `Bearer ${scenario.credential}`,
        body: scenario.expectedBody[index],
      })))
      const searchCall = sessionEvents.find(
        (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
          event.type === 'tool/call' && event.data.name === 'web_search',
      )
      if (searchCall === undefined) throw new Error('the replayed turn did not call web_search')
      expect(JSON.parse(searchCall.data.arguments)).toEqual({ queries: [...QUERIES] })
      const searchResult = sessionEvents.find(
        (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
          event.type === 'tool/result' && event.data.message.source.callId === searchCall.data.callId,
      )
      if (searchResult === undefined) throw new Error('web_search produced no durable result')
      expect(searchResult.data.message.content).toEqual([{
        type: 'tool-result',
        toolCallId: searchCall.data.callId,
        isError: false,
        content: [{ type: 'text', text: scenario.expectedText }],
      }])
      expect(searchResult.data.meta).toEqual(scenario.expectedMeta)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }, 200_000)
  },
)
