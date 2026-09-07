// @vitest-environment jsdom
// FileChips behavior in the jsdom lane: chip lifecycle surfaces (uploading
// progress, determinate and indeterminate), the settled states (done, error
// with its line), removal callbacks, the badge row, and the shared
// handle-format size text.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FileBadgeList, FileChipRail, fileSizeText } from '../src/FileChips.tsx'
import type { FileBadgeItem, FileChipItem, FileChipLabels } from '../src/FileChips.tsx'

afterEach(cleanup)

const labels: FileChipLabels = {
  group: '待发送文件',
  removeLabel: name => `移除文件 ${name}`,
  uploading: '文件上传中',
}

function chip(over: Partial<FileChipItem> = {}): FileChipItem {
  return { id: 'f1', name: '报告.md', bytes: 2048, status: 'uploading', ...over }
}

describe('fileSizeText', () => {
  it('formats bytes in the host handle text human format', () => {
    expect(fileSizeText(0)).toBe('0 B')
    expect(fileSizeText(958)).toBe('958 B')
    expect(fileSizeText(1536)).toBe('1.5 KB')
    expect(fileSizeText(12 * 1024 * 1024)).toBe('12 MB')
    expect(fileSizeText(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})

describe('FileChipRail', () => {
  it('renders one chip per draft file with name, size, and state', () => {
    const view = render(
      <FileChipRail
        items={[chip(), chip({ id: 'f2', name: 'data.csv', bytes: 30 * 1024 * 1024, status: 'error', error: '网络异常' })]}
        labels={labels}
        onRemove={() => {}}
      />,
    )
    expect(view.getByText('报告.md')).toBeDefined()
    expect(view.getByText('2 KB')).toBeDefined()
    expect(view.getByText('30 MB · 网络异常')).toBeDefined()
    expect(view.container.querySelectorAll('[data-file-chip="uploading"]').length).toBe(1)
    expect(view.container.querySelector('[data-file-chip="error"]')).not.toBeNull()
  })

  it('shows a determinate progress bar while uploading with a known fraction', () => {
    const view = render(<FileChipRail items={[chip({ progress: 0.25 })]} labels={labels} onRemove={() => {}} />)
    const bar = view.getByRole('progressbar', { name: '文件上传中' })
    expect(bar.firstElementChild?.getAttribute('style')).toContain('width: 25%')
    expect(bar.firstElementChild?.getAttribute('data-indeterminate')).toBeNull()
  })

  it('marks the progress bar indeterminate while the fraction is unknown', () => {
    const view = render(<FileChipRail items={[chip()]} labels={labels} onRemove={() => {}} />)
    const bar = view.getByRole('progressbar')
    expect(bar.firstElementChild?.getAttribute('data-indeterminate')).toBe('true')
    expect(bar.firstElementChild?.getAttribute('style')).toBeNull()
  })

  it('removes through the owner callback with the chip identity', () => {
    const onRemove = vi.fn()
    const view = render(<FileChipRail items={[chip()]} labels={labels} onRemove={onRemove} />)
    fireEvent.click(view.getByRole('button', { name: '移除文件 报告.md' }))
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }))
  })
})

describe('FileBadgeList', () => {
  it('renders one link-colored badge per admitted file and nothing without files', () => {
    const files: FileBadgeItem[] = [
      { name: '报告.md', bytes: 2048 },
      { name: '快照.png', bytes: 300 * 1024 },
    ]
    const view = render(<FileBadgeList files={files} labels={{ group: '已发送文件' }} />)
    expect(view.getByRole('group', { name: '已发送文件' })).toBeDefined()
    expect(view.getByText('报告.md')).toBeDefined()
    expect(view.getByText('2 KB')).toBeDefined()
    expect(view.getByText('快照.png')).toBeDefined()
    expect(view.getByText('300 KB')).toBeDefined()

    const empty = render(<FileBadgeList files={[]} labels={{ group: '已发送文件' }} />)
    expect(empty.container.firstChild).toBeNull()
  })
})
