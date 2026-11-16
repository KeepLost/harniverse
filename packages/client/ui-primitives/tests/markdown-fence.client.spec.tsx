// @vitest-environment jsdom
// Diff fences: row parsing (budget-aware hunks, per-file languages), the
// CodeBlock diff arm, and the MarkdownText fence delegate that an owner uses
// to take over rendering for every fence with a final language.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { diffFenceTokens, isDiffFenceLanguage, parseDiffFence } from '../src/markdown/diff-fence.ts'
import { FenceCodeBlock, FenceMathBlock } from '../src/markdown/FenceBlocks.tsx'
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

describe('FenceBlocks', () => {
  it('renders a fence body as a code block, plain while streaming', () => {
    const labels = { copyLabel: 'Copy', copiedLabel: 'Copied' }
    const view = render(
      <FenceCodeBlock code={'const x = 1'} streaming lang="typescript" labels={labels} />,
    )
    expect(view.container.textContent).toContain('const x = 1')
    const streaming = render(
      <FenceCodeBlock code={'const x = 1'} streaming lang="typescript" labels={labels} />,
    )
    expect(streaming.container.textContent).toContain('const x = 1')
    const plain = render(
      <FenceCodeBlock code={'plain text'} streaming={false} labels={labels} />,
    )
    expect(plain.container.textContent).toContain('plain text')
  })

  it('renders a math fence body as display TeX', () => {
    const view = render(<FenceMathBlock code={'E = mc^2'} />)
    expect(view.container.textContent).toContain('E=mc2')
  })
})

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

  it('tokenizes a known-language diff and refuses one without content rows', () => {
    const tokenized = diffFenceTokens(parseDiffFence(GIT_DIFF))
    expect(tokenized).toBeDefined()
    expect(tokenized?.get(5)).toBeDefined()
    // A bare meta diff has no content rows to group, so nothing is tokenized.
    expect(diffFenceTokens(parseDiffFence('diff --git a/x b/x'))).toBeUndefined()
  })

  it('parses quoted headers, /dev/null sides, and marker-less hunks', () => {
    const quoted = parseDiffFence([
      'diff --git "a/one two.ts" "b/one two.ts"',
      'index 0000001..0000002 100644',
      '--- "a/one two.ts"',
      '+++ b/one two.ts',
      '@@ -1,2 +1,2 @@',
      '-const gone = 2',
      '+const added = 3',
    ].join('\n'))
    expect(quoted.languages.get(0)).toBe('typescript')

    const created = parseDiffFence([
      'diff --git a/x b/x',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/x.ts',
      '@@ -0,0 +1 @@',
      '+const x = 1',
    ].join('\n'))
    // The /dev/null old side carries no language; the new side names it.
    expect(created.languages.get(0)).toBe('typescript')

    const markerless = parseDiffFence([
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ malformed @@',
      '-const gone = 2',
      'context without its marker column',
      ' kept marker column under the malformed hunk',
    ].join('\n'))
    expect(markerless.rows.map(row => row.kind)).toEqual([
      'meta', 'meta', 'meta', 'hunk', 'del', 'context', 'context',
    ])
  })

  it('keeps a trailing empty body row plain while its siblings tokenize', () => {
    const diff = parseDiffFence([
      'diff --git a/src/one.ts b/src/one.ts',
      'index 0000001..0000002 100644',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1,2 +1,2 @@',
      '-const gone = 2',
      '-',
    ].join('\n'))
    const tokens = diffFenceTokens(diff)
    expect(tokens).toBeDefined()
    expect(tokens?.get(5)).toBeDefined()
    expect(tokens?.get(6)).toEqual([])
  })

  it('leaves a file section without an extension untokenized', () => {
    const fence = parseDiffFence([
      'diff --git a/Makefile b/Makefile',
      'index 0000001..0000002 100644',
      '--- a/Makefile',
      '+++ b/Makefile',
      '@@ -1 +1 @@',
      '-all:',
      '+all: build',
    ].join('\n'))
    expect(fence.languages.get(0)).toBeUndefined()
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

  it('carries the fence meta string to the owner renderer', () => {
    const seen: MarkdownDelegateFenceInfo[] = []
    render(
      <MarkdownText
        text={'```ts title="consts"\nconst x = 1\n```'}
        renderCode={(fence) => {
          seen.push(fence)
          return <p>{fence.meta}</p>
        }}
      />,
    )
    expect(seen[0]?.meta).toBe('title="consts"')
  })

  it('keeps the built-in code and math blocks without a delegate', () => {
    const view = render(<MarkdownText text={'```ts\nconst x = 1\n```'} />)
    expect(view.container.querySelector('.md-code-block')).toBeTruthy()
  })
})
