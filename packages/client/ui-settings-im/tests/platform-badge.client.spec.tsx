// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PlatformBadge } from '../src/client/PlatformBadge.tsx'

afterEach(cleanup)

function badge(platform: string, label: string): HTMLElement {
  return render(<PlatformBadge platform={platform} label={label} />).container.firstElementChild as HTMLElement
}

describe('PlatformBadge', () => {
  it('draws a glyph for Telegram', () => {
    const element = badge('telegram', 'Telegram')
    expect(element.querySelector('svg')).not.toBeNull()
    expect(element.textContent).toBe('')
  })

  it('uses the 飞 monogram for Feishu', () => {
    expect(badge('feishu', '飞书').textContent).toBe('飞')
  })

  it('falls back to the capitalized first letter of the label for any other platform', () => {
    expect(badge('slack', 'slack').textContent).toBe('S')
  })

  it('keeps a first letter outside the basic plane whole', () => {
    expect(badge('x', '𠮷野家').textContent).toBe('𠮷')
  })

  it('shows a placeholder for a platform with no label', () => {
    expect(badge('x', '').textContent).toBe('?')
  })

  it('is decorative and carries the platform id for styling', () => {
    const element = badge('slack', 'Slack')
    expect(element.getAttribute('aria-hidden')).toBe('true')
    expect(element.getAttribute('data-platform')).toBe('slack')
  })
})
