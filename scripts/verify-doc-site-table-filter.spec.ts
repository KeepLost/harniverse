// @vitest-environment jsdom
/** Tests for the documentation-site long-table filter. */

import assert from 'node:assert/strict'
import { fireEvent, getByRole, queryAllByRole } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentTables } from '../website/.vitepress/theme/table-filter.ts'

let tables: DocumentTables | undefined
let article: HTMLElement
let language: string
let frameId: number
const frames = new Map<number, FrameRequestCallback>()

class ResizeObserverFixture implements ResizeObserver {
  readonly observe = (): void => {}
  readonly unobserve = (): void => {}
  readonly disconnect = (): void => {}
}

beforeEach(() => {
  language = 'en-US'
  frameId = 0
  document.body.innerHTML = '<div id="VPContent" class="VPDoc"><main><div class="vp-doc"></div></main></div>'
  const content = document.querySelector<HTMLElement>('.vp-doc')
  assert(content)
  article = content
  vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames.delete(id)
  })
})

afterEach(() => {
  tables?.dispose()
  tables = undefined
  frames.clear()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function renderTable(count = 10, withHead = true): {
  section: HTMLElement
  table: HTMLTableElement
  rows: HTMLTableRowElement[]
} {
  const section = document.createElement('section')
  const table = document.createElement('table')
  table.innerHTML = `${withHead ? '<thead><tr><th>Service</th><th>Package</th></tr></thead>' : ''}<tbody></tbody>`
  const body = table.tBodies[0]
  assert(body)
  for (let index = 0; index < count; index++) {
    const row = body.insertRow()
    row.innerHTML = index === 0
      ? '<td><code>ctx.llm</code></td><td><a href="/reference/llm">llm-deepseek</a></td>'
      : `<td>service-${index}</td><td>package-${index}</td>`
    for (const cell of row.cells) {
      // jsdom has no layout-backed innerText; these fixtures contain only visible text.
      Object.defineProperty(cell, 'innerText', { get: () => cell.textContent })
    }
  }
  section.append(table)
  article.append(section)
  return { section, table, rows: Array.from(body.rows) }
}

function install(): DocumentTables {
  tables = new DocumentTables(document, () => language)
  return tables
}

function visible(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.tBodies).flatMap(body => Array.from(body.rows)).filter(row => !row.hidden)
}

function search(section: HTMLElement, value: string): HTMLInputElement {
  const input = getByRole<HTMLInputElement>(section, 'searchbox')
  fireEvent.input(input, { target: { value } })
  return input
}

describe('documentation table filtering', () => {
  it('enhances only article tables with a head and at least ten data rows', () => {
    const short = renderTable(9)
    const headless = renderTable(10, false)
    const long = renderTable(10)
    install()
    expect(queryAllByRole(short.section, 'searchbox')).toHaveLength(0)
    expect(queryAllByRole(headless.section, 'searchbox')).toHaveLength(0)
    expect(getByRole<HTMLInputElement>(long.section, 'searchbox').placeholder).toBe('Search…')
    expect(visible(long.table)).toEqual(long.rows)
  })

  it('hides non-matching rows and restores them on clear', () => {
    const fixture = renderTable()
    install()
    const input = search(fixture.section, '  PACKAGE-3  ')
    expect(visible(fixture.table)).toEqual([fixture.rows[3]])
    expect(Array.from(fixture.table.tBodies).flatMap(body => Array.from(body.rows))).toHaveLength(10)
    const clear = getByRole<HTMLButtonElement>(fixture.section, 'button', { name: 'Clear' })
    fireEvent.click(clear)
    expect(clear.hidden).toBe(true)
    expect(input.value).toBe('')
    expect(visible(fixture.table)).toEqual(fixture.rows)
  })

  it('reports an empty result through the live status', () => {
    const fixture = renderTable()
    install()
    search(fixture.section, 'unmatched')
    expect(visible(fixture.table)).toHaveLength(0)
    expect(getByRole(fixture.section, 'status').textContent).toBe('No matching rows.')
  })

  it('localizes controls for the Chinese root locale', () => {
    language = 'zh-CN'
    const fixture = renderTable()
    install()
    const input = getByRole<HTMLInputElement>(fixture.section, 'searchbox', { name: '筛选表格' })
    expect(input.placeholder).toBe('搜索…')
    fireEvent.input(input, { target: { value: 'unmatched' } })
    const clear = getByRole<HTMLButtonElement>(fixture.section, 'button', { name: '清空' })
    expect(clear.title).toBe('清空')
    expect(getByRole(fixture.section, 'status').textContent).toBe('无匹配行。')
  })

  it('preserves an active query when unchanged content refreshes', () => {
    const fixture = renderTable()
    const owner = install()
    const input = search(fixture.section, 'package-3')
    owner.refresh()
    owner.refresh()
    expect(getByRole(fixture.section, 'searchbox')).toBe(input)
    expect(visible(fixture.table)).toEqual([fixture.rows[3]])
  })

  it('removes controls and restores original visibility on disposal', () => {
    const fixture = renderTable()
    const first = fixture.rows[0]
    assert(first)
    first.hidden = true
    const owner = install()
    const input = search(fixture.section, 'unmatched')
    expect(visible(fixture.table)).toHaveLength(0)
    owner.dispose()
    tables = undefined
    expect(queryAllByRole(fixture.section, 'searchbox')).toHaveLength(0)
    expect(fixture.table.classList.contains('dsh-filterable-table')).toBe(false)
    expect(visible(fixture.table)).toEqual(fixture.rows.slice(1))
    fireEvent.input(input, { target: { value: 'package-3' } })
    expect(visible(fixture.table)).toEqual(fixture.rows.slice(1))
  })
})
