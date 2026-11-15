// @vitest-environment jsdom
// Diff fences: row parsing (budget-aware hunks, per-file languages), the
// CodeBlock diff arm, and the MarkdownText fence delegate that an owner uses
// to take over rendering for every fence with a final language.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { isDiffFenceLanguage, parseDiffFence } from '../src/markdown/diff-fence.ts'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import type { MarkdownDelegateFenceInfo } from '../src/markdown/render.tsx'

afterEach(cleanup)

const GIT_DIFF = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 0000001..0000002 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,2 +1,2 @@',
  ' const same = 1',
  '-const gone = 2',
  '+const added = 3',
].join('\n')

describe('parseDiffFence', () => {
  it('classifies rows and names each file section language', () => {
    const fence = parseDiffFence(GIT_DIFF)
    expect(fence.rows.map(row => row.kind)).toEqual([
      'meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add',
    ])
    expect(fence.languages.get(0)).toBe('typescript')
    const del = fence.rows[6]
    expect(del?.marker).toBe('-')
    expect(del?.body).toBe('const gone = 2')
  })

  it('ends a hunk by its header budget, so a following file header is chrome again', () => {
    const fence = parseDiffFence([
      '--- a/x.py',
      '+++ b/x.py',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '--- a/y.rs',
      '+++ b/y.rs',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n'))
    expect(fence.rows[5]?.kind).toBe('meta')
    expect(fence.languages.get(1)).toBe('rust')
    expect(fence.rows.filter(row => row.kind === 'del')).toHaveLength(2)
  })

  it('selects diff and patch info strings case-insensitively', () => {
    expect(isDiffFenceLanguage('diff')).toBe(true)
    expect(isDiffFenceLanguage('Patch')).toBe(true)
    expect(isDiffFenceLanguage('typescript')).toBe(false)
    expect(isDiffFenceLanguage(undefined)).toBe(false)
  })
})

describe('CodeBlock diff arm', () => {
  it('renders marker-colored rows for a diff fence, keeping the source copyable', () => {
    const view = render(<CodeBlock code={`${GIT_DIFF}\n`} lang="diff" />)
    const rows = view.container.querySelectorAll('.line')
    expect(rows.length).toBe(8)
    expect(rows[6]?.textContent).toBe('-const gone = 2')
    expect(rows[6]?.className).toContain('diffDel')
    expect(rows[7]?.className).toContain('diffAdd')
    expect(view.container.querySelector('pre')?.textContent).toContain('diff --git a/src/one.ts b/src/one.ts')
  })

  it('renders diff rows for an unlabeled fence forced through the diff prop', () => {
    const view = render(<CodeBlock code={'-gone\n+new\n'} diff />)
    expect(view.container.querySelectorAll('[class*="diffDel"], [class*="diffAdd"]').length).toBe(2)
  })
})

describe('MarkdownText fence delegate', () => {
  it('hands every final-language fence to the owner renderer in a seat', () => {
    const seen: MarkdownDelegateFenceInfo[] = []
    const view = render(
      <MarkdownText
        text={'```ts\nconst x = 1\n```\n\n```math\nE=mc^2\n```'}
        renderCode={(fence) => {
          seen.push(fence)
          return <p data-fence={fence.lang}>{fence.code}</p>
        }}
      />,
    )
    expect(seen.map(fence => fence.lang)).toEqual(['ts', 'math'])
    expect(seen[0]?.code).toBe('const x = 1')
    expect(seen[0]?.streaming).toBe(false)
    expect(view.getByText('const x = 1')).toBeTruthy()
    expect(view.getByText('E=mc^2')).toBeTruthy()
  })

  it('keeps the built-in code and math blocks without a delegate', () => {
    const view = render(<MarkdownText text={'```ts\nconst x = 1\n```'} />)
    expect(view.container.querySelector('.md-code-block')).toBeTruthy()
  })
})
