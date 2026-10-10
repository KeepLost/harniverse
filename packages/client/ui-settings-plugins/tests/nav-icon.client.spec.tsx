// @vitest-environment jsdom
/** The Plugins settings nav glyph: the shared IconPersonalizationOutline16 primitive at the nav size. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconPersonalizationOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { PluginsNavIcon } from '../src/client/NavIcon.tsx'

afterEach(cleanup)

describe('PluginsNavIcon', () => {
  it('draws the IconPersonalizationOutline16 glyph at the 16px nav size', () => {
    const glyph = render(<PluginsNavIcon />).container
    const svg = glyph.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(glyph.innerHTML).toBe(render(<IconPersonalizationOutline16 size={16} />).container.innerHTML)
  })
})
