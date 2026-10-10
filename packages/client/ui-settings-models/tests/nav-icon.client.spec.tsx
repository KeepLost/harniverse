// @vitest-environment jsdom
/** The Models settings nav glyph: the shared IconDataOutline16 primitive at the nav size. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ModelsNavIcon } from '../src/client/NavIcon.tsx'

afterEach(cleanup)

describe('ModelsNavIcon', () => {
  it('draws the IconDataOutline16 glyph at the 16px nav size', () => {
    const glyph = render(<ModelsNavIcon />).container
    const svg = glyph.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(glyph.innerHTML).toBe(render(<IconDataOutline16 size={16} />).container.innerHTML)
  })
})
