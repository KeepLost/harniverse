// @vitest-environment jsdom
/** The agent preset settings nav glyph: the shared IconAgentPresetOutline16 primitive at the nav size. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentPresetNavIcon } from '../src/client/NavIcon.tsx'

afterEach(cleanup)

describe('AgentPresetNavIcon', () => {
  it('draws the IconAgentPresetOutline16 glyph at the 16px nav size', () => {
    const glyph = render(<AgentPresetNavIcon />).container
    const svg = glyph.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(glyph.innerHTML).toBe(render(<IconAgentPresetOutline16 size={16} />).container.innerHTML)
  })
})
