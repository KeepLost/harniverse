import { describe, expect, it } from 'vitest'
import type { SkinBackground, SkinGradientLayer } from '@deepseek-ai/dsh-api-remotes/client'
import { gradientCss } from '../src/client/gradient.ts'

const linear: SkinGradientLayer = { type: 'linear', angle: 165, stops: [['#121216', 0], ['#101016', 100]] }
const radial: SkinGradientLayer = { type: 'radial', at: [20, 10], size: 60, stops: [['#5e6ad240', 0], ['transparent', 100]] }

const background = (...layers: SkinGradientLayer[]): SkinBackground => ({ kind: 'gradient', layers })

describe('gradient builder', () => {
  it('builds linear and radial layers, first layer on top', () => {
    expect(gradientCss(background(radial, linear))).toBe(
      'radial-gradient(circle 60vmax at 20% 10%, #5e6ad240 0%, transparent 100%), '
      + 'linear-gradient(165deg, #121216 0%, #101016 100%)',
    )
  })

  it('normalises angles and clamps positions and radial geometry', () => {
    expect(gradientCss(background({ type: 'linear', angle: -90, stops: [['#fff', -10], ['#000', 140]] })))
      .toBe('linear-gradient(270deg, #fff 0%, #000 100%)')
    expect(gradientCss(background({ type: 'linear', angle: 725, stops: [['#fff', 0.456], ['#000', 100]] })))
      .toBe('linear-gradient(5deg, #fff 0.46%, #000 100%)')
    expect(gradientCss(background({ type: 'radial', at: [-5, 120], size: 900, stops: [['#fff', 0], ['#000', 100]] })))
      .toBe('radial-gradient(circle 150vmax at 0% 100%, #fff 0%, #000 100%)')
    expect(gradientCss(background({ type: 'radial', at: [50, 50], size: 0, stops: [['#fff', 0], ['#000', 100]] })))
      .toBe('radial-gradient(circle 1vmax at 50% 50%, #fff 0%, #000 100%)')
  })

  it('drops a layer whole when a colour or number is unusable', () => {
    const stops: SkinGradientLayer['stops'] = [['#fff', 0], ['#000', 100]]
    const dirty: SkinGradientLayer[] = [
      { type: 'linear', angle: 10, stops: [['url(x)', 0], ['#000', 100]] },
      { type: 'linear', angle: 10, stops: [['#fff', Number.NaN], ['#000', 100]] },
      { type: 'linear', angle: 10, stops: [['#fff', 0]] },
      { type: 'linear', angle: Number.POSITIVE_INFINITY, stops },
      { type: 'radial', at: [Number.NaN, 0], size: 10, stops },
      { type: 'radial', at: [0, Number.NaN], size: 10, stops },
      { type: 'radial', at: [0, 0], size: Number.NaN, stops },
    ]
    expect(gradientCss(background(...dirty))).toBeUndefined()
    expect(gradientCss(background(...dirty, linear))).toBe('linear-gradient(165deg, #121216 0%, #101016 100%)')
  })

  it('answers undefined for an empty layer list', () => {
    expect(gradientCss(background())).toBeUndefined()
  })
})
