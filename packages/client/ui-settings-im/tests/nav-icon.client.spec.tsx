// @vitest-environment jsdom
/** The IM bots settings nav glyph: the shared IconNewChatOutline16 primitive at the nav size. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconNewChatOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImNavIcon } from '../src/client/NavIcon.tsx'

afterEach(cleanup)

describe('ImNavIcon', () => {
  it('draws the IconNewChatOutline16 glyph at the 16px nav size', () => {
    const glyph = render(<ImNavIcon />).container
    const svg = glyph.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(glyph.innerHTML).toBe(render(<IconNewChatOutline16 size={16} />).container.innerHTML)
  })
})
