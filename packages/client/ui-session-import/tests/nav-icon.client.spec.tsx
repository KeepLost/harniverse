// @vitest-environment jsdom
/** The session import settings nav glyph: the shared IconDownloadOutline16 primitive at the nav size. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionImportNavIcon } from '../src/client/NavIcon.tsx'

afterEach(cleanup)

describe('SessionImportNavIcon', () => {
  it('draws the IconDownloadOutline16 glyph at the 16px nav size', () => {
    const glyph = render(<SessionImportNavIcon />).container
    const svg = glyph.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(glyph.innerHTML).toBe(render(<IconDownloadOutline16 size={16} />).container.innerHTML)
  })
})
