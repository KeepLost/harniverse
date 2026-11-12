// @vitest-environment jsdom
/**
 * Component behavior with direct props: totals header, turn rows, step
 * expansion, compaction rows, load-older control, and empty/loading states.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { StatsView } from '../src/client/StatsView.tsx'
import type { StatsSnapshot, StatsTrigger } from '../src/client/stats-contract.ts'
import { EMPTY_STATS_SNAPSHOT } from '../src/client/stats-contract.ts'
import { en, type StatsKey } from '../src/client/locales.ts'

afterEach(cleanup)

interface SessionFixture {
  views: { get: (target: string) => StatsSnapshot | undefined }
  openState: string
  loadingOlder: boolean
  hasMore: boolean
}

function makeProps(
  session: SessionFixture,
  loadOlder: () => Promise<boolean> = () => Promise.resolve(true),
): ComponentProps<typeof StatsView> {
  return {
    useSession: (selector: (snapshot: SessionFixture) => unknown) => selector(session),
    loadOlder,
    t: (key: StatsKey) => en[key],
  } as unknown as ComponentProps<typeof StatsView>
}

const USER: StatsTrigger = {
  sourceKind: 'user', plugin: null, form: null, summary: null, preview: 'hello', files: 3, images: 2,
}

const SNAP: StatsSnapshot = {
  rows: [
    {
      kind: 'turn', turn: 1, ended: true, closeKind: 'completed', closeTime: 9_000,
      trigger: USER,
      steps: [
        {
          turn: 1, step: 1, anchorSeq: 2, startTime: 1_000, endTime: 2_000, closed: true,
          firstTokenTime: 1_100, messageTime: 1_500, interrupted: false,
          usage: { inputTokens: 2_900, outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 100 },
          retries: 1,
          calls: [
            { callId: 'c1', name: 'fs', startedAt: 1_200, endedAt: 1_260, ms: 60, error: false, chars: 30 },
            { callId: 'c2', name: 'fs', startedAt: 1_300, endedAt: 1_340, ms: 40, error: true, chars: 5 },
          ],
          toolMs: 100, toolWall: 100, toolOpen: 0, answer: 'Done.',
        },
      ],
      compactions: [
        {
          anchorSeq: 3, turn: 1, startedAt: 1_600, endedAt: 1_720, provider: 'deepseek', model: 'V4',
          usage: { inputTokens: 4_000, outputTokens: 500 }, shadowedTokenCount: 5_000, error: null,
        },
      ],
    },
    {
      kind: 'compaction',
      facts: {
        anchorSeq: 4, turn: null, startedAt: 2_000, endedAt: 2_100, provider: 'deepseek', model: 'V4',
        usage: null, shadowedTokenCount: 800, error: 'budget exceeded',
      },
    },
  ],
  totals: {
    turns: 1, steps: 1, inputTokens: 2_900, llmMs: 500, toolMs: 100,
    ttftMs: 100, ttftSteps: 1, decodeMs: 400, decodeTokens: 100,
    outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 100, retries: 1, toolErrors: 1,
  },
}

function session(over: Partial<SessionFixture> = {}, snapshot: StatsSnapshot = SNAP): SessionFixture {
  return {
    views: { get: (target: string) => (target === 'stats' ? snapshot : undefined) },
    openState: 'ready',
    loadingOlder: false,
    hasMore: false,
    ...over,
  }
}

/** Variant rows exercising the remaining presentation branches. */
const VARIANTS: StatsSnapshot = {
  rows: [
    {
      kind: 'turn', turn: 4, ended: true, closeKind: 'aborted', closeTime: 9_000,
      trigger: { sourceKind: 'plugin', plugin: 'scheduler', form: 'notice', summary: 'cron fired', preview: null, files: 1, images: 0 },
      steps: [
        {
          turn: 4, step: 1, anchorSeq: 2, startTime: 1_000, endTime: null, closed: false,
          firstTokenTime: 1_100, messageTime: null, interrupted: false, usage: null,
          retries: 0, calls: [], toolMs: 0, toolWall: null, toolOpen: 2, answer: null,
        },
        {
          turn: 4, step: 2, anchorSeq: 3, startTime: 2_000, endTime: null, closed: true,
          firstTokenTime: null, messageTime: 2_500, interrupted: true, usage: null,
          retries: 0, calls: [], toolMs: 0, toolWall: null, toolOpen: 0, answer: null,
        },
      ],
      compactions: [
        {
          anchorSeq: 9, turn: 4, startedAt: 1_500, endedAt: null, provider: null, model: null,
          usage: null, shadowedTokenCount: null, error: null,
        },
      ],
    },
    {
      kind: 'turn', turn: 5, ended: false, closeKind: 'exotic-future-kind', closeTime: null,
      trigger: null,
      steps: [],
      compactions: [],
    },
    {
      kind: 'turn', turn: 6, ended: true, closeKind: 'completed', closeTime: 9_500,
      trigger: { sourceKind: 'cron', plugin: null, form: null, summary: null, preview: null, files: 0, images: 0 },
      steps: [],
      compactions: [],
    },
    {
      kind: 'turn', turn: 9, ended: true, closeKind: 'completed', closeTime: 9_800,
      trigger: { sourceKind: 'user', plugin: null, form: null, summary: null, preview: 'cache reader', files: 0, images: 0 },
      steps: [
        {
          turn: 9, step: 1, anchorSeq: 2, startTime: 1_000, endTime: 1_400, closed: true,
          firstTokenTime: 1_050, messageTime: 1_200, interrupted: false,
          usage: { inputTokens: 30, outputTokens: 6, cacheReadTokens: 60 },
          retries: 0, calls: [], toolMs: 0, toolWall: null, toolOpen: 0, answer: null,
        },
      ],
      compactions: [],
    },
    {
      kind: 'turn', turn: 8, ended: true, closeKind: 'completed', closeTime: 9_700,
      trigger: { sourceKind: 'user', plugin: null, form: null, summary: null, preview: 'cache writer', files: 0, images: 0 },
      steps: [
        {
          turn: 8, step: 1, anchorSeq: 2, startTime: 1_000, endTime: 1_400, closed: true,
          firstTokenTime: 1_050, messageTime: 1_200, interrupted: false,
          usage: { inputTokens: 20, outputTokens: 5, cacheWriteTokens: 50 },
          retries: 0, calls: [], toolMs: 0, toolWall: null, toolOpen: 0, answer: null,
        },
      ],
      compactions: [],
    },
    {
      kind: 'turn', turn: 7, ended: true, closeKind: 'completed', closeTime: 9_600,
      trigger: { sourceKind: 'cron', plugin: null, form: null, summary: null, preview: 'wake', files: 0, images: 0 },
      steps: [
        {
          turn: 7, step: 1, anchorSeq: 2, startTime: 1_000, endTime: 1_400, closed: true,
          firstTokenTime: 1_050, messageTime: 1_200, interrupted: false,
          usage: { inputTokens: 5, outputTokens: 5 },
          retries: 0, calls: [], toolMs: 0, toolWall: null, toolOpen: 0, answer: null,
        },
      ],
      compactions: [],
    },
  ],
  totals: {
    turns: 6, steps: 5, inputTokens: 0, llmMs: 0, toolMs: 0,
    ttftMs: 100, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, retries: 0, toolErrors: 0,
  },
}

describe('StatsView', () => {
  it('renders the totals header and collapsed turn rows', () => {
    render(createElement(StatsView, makeProps(session())))
    expect(screen.getByText('Loaded-window totals')).toBeTruthy()
    expect(screen.getByText('Turns 1')).toBeTruthy()
    expect(screen.getByText('Model time 500 ms')).toBeTruthy()
    expect(screen.getByText('Output tokens 100')).toBeTruthy()
    expect(screen.getByText('Cache hit 41%')).toBeTruthy()
    expect(screen.getByTitle('hello')).toBeTruthy()
    expect(screen.getByText('2 images · 1 files')).toBeTruthy()
    expect(screen.queryByText('#1')).toBeNull()
  })

  it('expands a turn into its step row and compaction line on click', () => {
    render(createElement(StatsView, makeProps(session())))
    fireEvent.click(screen.getByRole('button', { name: 'Expand turn' }))
    expect(screen.getByText(/#1/)).toBeTruthy()
    expect(screen.getByText(/fs×2/)).toBeTruthy()
    expect(screen.getByText(/Shadowed 5000/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse turn' }))
    expect(screen.queryByText(/fs×2/)).toBeNull()
  })

  it('renders the standalone compaction row with its error', () => {
    render(createElement(StatsView, makeProps(session())))
    expect(screen.getByText(/budget exceeded/)).toBeTruthy()
  })

  it('offers load-older only while history remains', () => {
    const loadOlder = vi.fn(async () => true)
    const view = (fixture: SessionFixture) => createElement(StatsView, makeProps(fixture, loadOlder))
    const { rerender } = render(view(session({ hasMore: true })))
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier turns' }))
    expect(loadOlder).toHaveBeenCalledOnce()
    rerender(view(session({ hasMore: true, loadingOlder: true })))
    const loading = screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement
    expect(loading.disabled).toBe(true)
    rerender(view(session()))
    expect(screen.queryByRole('button', { name: 'Load earlier turns' })).toBeNull()
  })

  it('renders close badges, trigger variants, open tools, and interrupted steps', () => {
    render(createElement(StatsView, makeProps(session({}, VARIANTS))))
    expect(screen.getByText('Aborted')).toBeTruthy()
    expect(screen.queryByText('exotic-future-kind')).toBeNull()
    expect(screen.getByTitle('cron fired')).toBeTruthy()
    expect(screen.getByText('Plugin:scheduler')).toBeTruthy()
    expect(screen.getByText('1 files')).toBeTruthy()
    expect(screen.getAllByText('cron').length).toBe(2)
    expect(screen.getByTitle('cron')).toBeTruthy()
    expect(screen.getByTitle('wake')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText('Avg TTFT —')).toBeTruthy()
    for (const button of screen.getAllByRole('button', { name: 'Expand turn' })) {
      fireEvent.click(button)
    }
    expect(screen.getByText('Running')).toBeTruthy()
    const cells = screen.getAllByText(/·/).map(el => el.textContent)
    expect(cells).toContain('0·50 —')
    expect(screen.getByText('Interrupted')).toBeTruthy()
    expect(screen.getByText(/2 Open/)).toBeTruthy()
    expect(screen.getByText(/Compaction · —/)).toBeTruthy()
  })

  it('falls back to the empty snapshot before the stats target registers', () => {
    const bare: SessionFixture = {
      views: { get: () => undefined }, openState: 'ready', loadingOlder: false, hasMore: false,
    }
    render(createElement(StatsView, makeProps(bare)))
    expect(screen.getByText('No statistics yet')).toBeTruthy()
  })

  it('shows the loading and empty states', () => {
    const view = (fixture: SessionFixture) => createElement(StatsView, makeProps(fixture))
    const { rerender } = render(view(session({ openState: 'loading' }, EMPTY_STATS_SNAPSHOT)))
    expect(screen.getByText('Loading…')).toBeTruthy()
    rerender(view(session({}, EMPTY_STATS_SNAPSHOT)))
    expect(screen.getByText('No statistics yet')).toBeTruthy()
  })
})
