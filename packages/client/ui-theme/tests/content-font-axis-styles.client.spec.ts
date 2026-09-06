/**
 * Content font-size axis stylesheet contract, asserted against the CSS text on
 * disk: gradient-shadow-text.css defines the `--dsw-content-font-size` axis
 * (16px default) and derives `--dsw-content-font-delta` from it; the markdown
 * h1–h4/base ladder rides the axis while the dense secondary tiers
 * (table/small/code) and every app-chrome font token stay fixed; the
 * transcript flow furniture (markdown body, user bubble, composer draft,
 * disclosure/tool rows, think/compaction/context/retry rows, message clock and
 * icon actions, stats line, turn status, workflow-run panel, message-feedback
 * actions) adopts the axis through `calc(<default> + delta)` or the axis value
 * itself, keeping the default rendering pixel-identical. Declarations are
 * pinned per consumer file so a rename or drift in any one surface fails next
 * to its selector.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** One flattened CSS rule: its comma-separated selector parts and its declarations in source order. */
interface CssRule {
  selectors: string[]
  declarations: [property: string, value: string][]
}

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/**
 * Flatten a stylesheet into rules. Whitespace, declaration order, and trailing
 * semicolons are normalized away; nesting and at-rules are not handled, which
 * no sheet under test uses for the declarations asserted here.
 * @param css - stylesheet text.
 * @returns one entry per rule, in source order.
 */
function parseRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: CssRule[] = []
  // Destructuring defaults only satisfy noUncheckedIndexedAccess; both groups
  // are unconditional in the pattern.
  for (const [, selector = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = body
      .split(';')
      .map(part => part.trim())
      .filter(part => part.includes(':'))
      .map((part): [string, string] => {
        const colon = part.indexOf(':')
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
      })
    rules.push({ selectors: selector.split(',').map(part => part.trim()), declarations })
  }
  return rules
}

/**
 * Declarations of every rule whose selector list contains the selector, from
 * one stylesheet on disk.
 * @param relative - path under packages/client/ of the css module.
 * @param selector - exact selector part to match.
 */
function declarationsOf(relative: string, selector: string): [string, string][] {
  return parseRules(read(relative))
    .filter(rule => rule.selectors.includes(selector))
    .flatMap(rule => rule.declarations)
}

const SIZE = '--dsw-content-font-size'
const DELTA = '--dsw-content-font-delta'
const d = (px: number | string): string => `calc(${px}px + var(${DELTA}, 0px))`
/** Delta form as written inside the defining sheet itself (no fallback). */
const ds = (px: number | string): string => `calc(${px}px + var(${DELTA}))`

const TYPOGRAPHY = '../src/styles/gradient-shadow-text.css'

describe('gradient-shadow-text.css content font-size axis', () => {
  const bodyDeclarations = new Map<string, string>(
    parseRules(read(TYPOGRAPHY))
      .filter(rule => rule.selectors.includes('body'))
      .flatMap(rule => rule.declarations),
  )

  it('defines the axis at the 16px default and derives the px delta from it', () => {
    expect(bodyDeclarations.get(SIZE)).toBe('16px')
    expect(bodyDeclarations.get(DELTA)).toBe(`calc(var(${SIZE}, 16px) - 16px)`)
  })

  it('rides the markdown body ladder on the axis', () => {
    expect(bodyDeclarations.get('--dsw-font-markdown-base')).toBe(`var(${SIZE}, 16px) / ${ds(28)} var(--dsw-font-family)`)
    expect(bodyDeclarations.get('--dsw-font-markdown-h4')).toBe(`600 var(${SIZE}, 16px) / ${ds(28)} var(--dsw-font-family)`)
    for (const [token, size, line] of [
      ['h1', 24, 34],
      ['h2', 22, 32],
      ['h3', 20, 30],
    ] as const) {
      expect(bodyDeclarations.get(`--dsw-font-markdown-${token}`)).toBe(`700 ${ds(size)} / ${ds(line)} var(--dsw-font-family)`)
    }
  })

  it('keeps the dense secondary markdown tiers and the app-chrome font tokens off the axis', () => {
    for (const [token, value] of [
      ['table', '15px/25px var(--dsw-font-family)'],
      ['small', '14px/24px var(--dsw-font-family)'],
      ['code', '14px/22px var(--ds-font-family-code)'],
      ['code-block', '13px/22px var(--ds-font-family-code)'],
    ] as const) {
      expect(bodyDeclarations.get(`--dsw-font-markdown-${token}`)).toBe(value)
    }
    expect(bodyDeclarations.get('--dsw-font-xs-13')).toBe('13px/20px var(--dsw-font-family)')
    expect(bodyDeclarations.get('--dsw-font-xxs-12')).toBe('12px/18px var(--dsw-font-family)')
  })
})

const CHAT = '../../ui-conversation/src/client/chat'
const SKELETON = '../../ui-conversation/src/client/skeleton'

describe('transcript body surfaces', () => {
  it('the assistant narration root follows the axis', () => {
    expect(declarationsOf(`${CHAT}/AssistantMarkdown.module.css`, '.root')).toEqual(expect.arrayContaining([
      ['font-size', `var(${SIZE}, 16px)`],
      ['line-height', d(28)],
    ] as [string, string][]))
  })

  it('the user bubble follows the axis', () => {
    expect(declarationsOf(`${CHAT}/MessageItem.module.css`, '.bubble')).toEqual(expect.arrayContaining([
      ['font-size', `var(${SIZE}, 16px)`],
      ['line-height', d(24)],
    ] as [string, string][]))
  })

  it('the composer draft card follows the axis (textarea, mirror, and backdrop inherit)', () => {
    expect(declarationsOf(`${SKELETON}/InputBar.module.css`, '.card')).toEqual(expect.arrayContaining([
      ['font-size', `var(${SIZE}, 16px)`],
      ['line-height', d(24)],
    ] as [string, string][]))
  })
})

describe('flow chrome rows', () => {
  it('the shared DisclosureRow scales its row height, leading box, glyphs, and title', () => {
    const css = '../../ui-primitives/src/DisclosureRow.module.css'
    expect(declarationsOf(css, '.row')).toEqual(expect.arrayContaining([['height', d(24)]] as [string, string][]))
    expect(declarationsOf(css, '.leading')).toEqual(expect.arrayContaining([
      ['width', d(16)],
      ['height', d(16)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.leading svg:not([data-state])')).toEqual(expect.arrayContaining([
      ['width', d(14)],
      ['height', d(14)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.title')).toEqual(expect.arrayContaining([
      ['font-size', d(14)],
      ['line-height', d(24)],
    ] as [string, string][]))
  })

  it('ToolRow and bash-row summaries follow the axis', () => {
    const toolRow = '../../ui-tool/src/client/tool/components/ToolRow.module.css'
    // ToolRow's own title inherits DisclosureRow's axis-driven chrome; only its
    // weight override is local. The bash row owns its title text.
    for (const selector of ['.summary', '.summarySuffix']) {
      expect(declarationsOf(toolRow, selector)).toEqual(expect.arrayContaining([
        ['font-size', d(14)],
        ['line-height', d(24)],
      ] as [string, string][]))
    }
    expect(declarationsOf(toolRow, '.fileLink')).toEqual(expect.arrayContaining([
      ['font-size', d(14)],
      ['line-height', d(24)],
    ] as [string, string][]))
    const bash = '../../ui-tool/src/client/tool/toolviews/bash-sample.module.css'
    for (const selector of ['.title', '.summary']) {
      expect(declarationsOf(bash, selector)).toEqual(expect.arrayContaining([
        ['font-size', d(14)],
        ['line-height', d(24)],
      ] as [string, string][]))
    }
  })

  it('think text, context injection, and command cards follow the axis', () => {
    for (const css of [
      `${CHAT}/ReasoningRow.module.css`,
      `${CHAT}/ContextInjectionRow.module.css`,
      `${CHAT}/GenericCommandCard.module.css`,
    ]) {
      const think = parseRules(read(css)).flatMap(rule => rule.declarations)
      expect(think).toEqual(expect.arrayContaining([
        ['font-size', d(14)],
        ['line-height', d(24)],
      ] as [string, string][]))
    }
  })

  it('compaction, retry, and turn-error rows follow the axis', () => {
    const css = `${CHAT}/MessageItem.module.css`
    expect(declarationsOf(css, '.compactionTitle')).toEqual(expect.arrayContaining([
      ['font-size', d(14)],
      ['line-height', d(24)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.retryRow')).toEqual(expect.arrayContaining([
      ['font-size', d(13)],
      ['line-height', d(20)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.turnErrorRow')).toEqual(expect.arrayContaining([
      ['font-size', d(13)],
      ['line-height', d(20)],
    ] as [string, string][]))
  })

  it('the message clock and icon actions follow the axis, glyphs riding the leading box edge', () => {
    const css = `${CHAT}/MessageIconActions.module.css`
    expect(declarationsOf(css, '.actions')).toEqual(expect.arrayContaining([['height', d(28)]] as [string, string][]))
    expect(declarationsOf(css, '.timeStart')).toEqual(expect.arrayContaining([
      ['font-size', d(14)],
      ['line-height', d(24)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.action')).toEqual(expect.arrayContaining([
      ['width', d(28)],
      ['height', d(28)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.action svg')).toEqual(expect.arrayContaining([
      ['width', d(16)],
      ['height', d(16)],
    ] as [string, string][]))
  })

  it('slot-injected message feedback actions match the host row at every size', () => {
    const css = '../../ui-message-feedback/src/client/MessageFeedbackActions.module.css'
    expect(declarationsOf(css, '.action')).toEqual(expect.arrayContaining([
      ['width', d(28)],
      ['height', d(28)],
    ] as [string, string][]))
    expect(declarationsOf(css, '.action svg')).toEqual(expect.arrayContaining([
      ['width', d(16)],
      ['height', d(16)],
    ] as [string, string][]))
  })

  it('the stats line, turn status, and workflow-run panel follow the axis', () => {
    expect(declarationsOf(`${CHAT}/StatsLine.module.css`, '.root')).toEqual(expect.arrayContaining([
      ['font-size', d(12)],
      ['line-height', d(20)],
    ] as [string, string][]))
    expect(declarationsOf(`${CHAT}/ChatView.module.css`, '.turnStatus')).toEqual(expect.arrayContaining([
      ['height', d(26)],
      ['font-size', d(14)],
      ['line-height', d(22)],
    ] as [string, string][]))
    expect(declarationsOf(`${CHAT}/ChatView.module.css`, '.turnStatusClock')).toEqual(expect.arrayContaining([
      ['font-size', d(13)],
      ['line-height', d(20)],
    ] as [string, string][]))
    const workflow = '../../ui-workflow-run/src/client/WorkflowRunPanel.module.css'
    expect(declarationsOf(workflow, '.runTitle')).toEqual(expect.arrayContaining([
      ['font-size', d(14)],
      ['line-height', d(24)],
    ] as [string, string][]))
    expect(declarationsOf(workflow, '.runSummary')).toEqual(expect.arrayContaining([
      ['font-size', d(12)],
      ['line-height', d(18)],
    ] as [string, string][]))
  })
})
