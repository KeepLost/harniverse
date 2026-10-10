import { describe, expect, it } from 'vitest'
import { previewStyle } from '../src/client/preview.ts'
import { GRADIENT, skin } from './fixtures.client.ts'

describe('previewStyle', () => {
  it('maps the core tokens onto the preview parts', () => {
    expect(previewStyle(skin('a'))).toEqual({
      '--dsh-skin-pv-bg': '#101014',
      '--dsh-skin-pv-side': '#18181e',
      '--dsh-skin-pv-text': '#f4f4f8',
      '--dsh-skin-pv-muted': '#b8b8c4',
      '--dsh-skin-pv-border': '#3a3a46',
      '--dsh-skin-pv-accent': '#5e6ad2',
    })
  })

  it('adds the gradient when the skin ships a usable background', () => {
    expect(previewStyle(skin('a', { background: GRADIENT }))['--dsh-skin-pv-image' as never]).toContain('linear-gradient(165deg')
  })

  it('leaves out any part whose colour is missing or outside the grammar, and a background with no usable layer', () => {
    const style = previewStyle(skin('a', {
      tokens: { '--dsw-alias-bg-base': 'url(https://example.test/x.png)', '--dsw-alias-label-primary': '#ffffff' },
      background: { kind: 'gradient', layers: [] },
    })) as Record<string, string>
    expect(style).toEqual({ '--dsh-skin-pv-text': '#ffffff' })
  })
})
