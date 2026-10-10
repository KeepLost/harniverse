/** Skin pack validation: accepted shapes, normalization, and every rejection class. */

import { describe, expect, it } from 'vitest'
import {
  CORE_TOKENS, DREAM_SKIN_FORMAT, MAX_GRADIENT_LAYERS, MAX_GRADIENT_STOPS, MAX_PACK_BYTES, MAX_PACK_TOKENS,
  PACK_FORMAT, SKINNABLE_TOKENS, isSkinColor, parseSkinPack, serializeSkinPack,
} from '../src/pack.ts'
import type { SkinDefinition } from '../src/types.ts'

const CORE_VALUES: Record<string, string> = {
  '--dsw-alias-bg-base': '#101014',
  '--dsw-alias-bg-layer-1': '#1b1e28',
  '--dsw-alias-label-primary': '#f4f5f7',
  '--dsw-alias-label-secondary': '#a5adb8',
  '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.07)',
  '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
  '--dsw-accent': '#5e6ad2',
}

/** A minimal valid native pack document, optionally patched. */
function nativePack(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PACK_FORMAT,
    version: 1,
    id: 'my-skin',
    name: 'My Skin',
    colorScheme: 'dark',
    tokens: { ...CORE_VALUES },
    ...patch,
  }
}

/** A minimal valid dsh-dream-skin envelope; `manifest` fields may be patched. */
function dreamPack(manifest: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}): Record<string, unknown> {
  const { '--dsw-accent': _accent, ...dreamTokens } = CORE_VALUES
  return {
    format: DREAM_SKIN_FORMAT,
    version: 1,
    manifest: {
      id: 'Aurora-Test',
      name: 'Aurora Test',
      nameZh: '极光测试',
      colorScheme: 'dark',
      tokens: { ...dreamTokens, '--dsw-alias-brand-primary': '#34d399' },
      ...manifest,
    },
    ...envelope,
  }
}

function parse(document: unknown): ReturnType<typeof parseSkinPack> {
  return parseSkinPack(typeof document === 'string' ? document : JSON.stringify(document))
}

function accepted(document: unknown): SkinDefinition {
  const result = parse(document)
  if (!result.ok) throw new Error(`expected an accepted pack, got: ${result.issues.join(' | ')}`)
  return result.skin
}

function issuesOf(document: unknown): readonly string[] {
  const result = parse(document)
  if (result.ok) throw new Error('expected a rejected pack')
  expect(result.issues.length).toBeGreaterThan(0)
  return result.issues
}

function expectIssue(document: unknown, fragment: string): void {
  expect(issuesOf(document).some(issue => issue.includes(fragment)), `no issue contains ${JSON.stringify(fragment)}`).toBe(true)
}

describe('colour grammar', () => {
  it.each([
    '#fff', '#FFF', '#abcd', '#101014', '#10101480', '#AbCdEf', 'transparent', 'TRANSPARENT',
    'rgb(1, 2, 3)', 'rgb(1 2 3)', 'rgba(255, 255, 255, 0.07)', 'rgba(255,255,255,.5)', 'rgb(1 2 3 / 0.5)', 'rgb(10% 20% 30%)',
    'rgb(1 2 3 /50%)', 'hsl(210, 50%, 40%)', 'hsla(210 50% 40% / .3)', 'HSL(210, 50%, 40%)', 'rgb( 1 , 2 , 3 )', 'rgb(+1, -2, 3.5)',
  ])('accepts %s', (value) => {
    expect(isSkinColor(value)).toBe(true)
  })

  it.each([
    'red', 'currentcolor', 'inherit', '#ff', '#fffff', '#ggg', '#1234567', '#123456789', 'ff0000', '',
    'url(x)', 'url(https://example.com/x.png)', 'var(--dsw-accent)', 'calc(1px + 2px)', 'color-mix(in srgb, red, blue)',
    'attr(x)', 'image-set(x 1x)', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(a, b, c)', 'rgb(1e2, 2, 3)', 'rgb(1, 2, 3', 'rgb(1, 2, 3))',
    'rgb(1, 2, 3) !important', '#fff;', '#fff}', '{#fff', '#fff"', "#fff'", '#fff\\', 'rgb(1, 2, 3)\n', ' #fff', '#fff ',
    'rgb(1\u00a02\u00a03)', 'rgb(1\u20282 3)', 'rgb(1\t2\t3)', 'rgb(1, 2, 3) /* c */', '</script>', '<b>', 'transparent;', 'rgb(1/2/3)',
    `#${'a'.repeat(70)}`, `rgb(${'1 '.repeat(40)})`,
  ])('rejects %j', (value) => {
    expect(isSkinColor(value)).toBe(false)
  })

  it('rejects non-string values', () => {
    for (const value of [1, null, undefined, {}, ['#fff'], true]) expect(isSkinColor(value)).toBe(false)
  })
})

describe('native packs', () => {
  it('accepts the minimal pack and normalizes it', () => {
    expect(accepted(nativePack())).toEqual({
      id: 'my-skin',
      source: 'pack',
      name: { zh: 'My Skin', en: 'My Skin' },
      colorScheme: 'dark',
      tokens: {
        '--dsw-accent': '#5e6ad2',
        '--dsw-alias-bg-base': '#101014',
        '--dsw-alias-bg-layer-1': '#1b1e28',
        '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.07)',
        '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
        '--dsw-alias-label-primary': '#f4f5f7',
        '--dsw-alias-label-secondary': '#a5adb8',
      },
    })
  })

  it('orders tokens by the allowlist regardless of document order', () => {
    const reversed = Object.fromEntries(Object.entries(CORE_VALUES).reverse())
    const skin = accepted(nativePack({ tokens: reversed }))
    expect(Object.keys(skin.tokens)).toEqual(SKINNABLE_TOKENS.filter(token => token in CORE_VALUES))
  })

  it('keeps localized names, optional text, and a lowercased accent', () => {
    const skin = accepted(nativePack({
      name: { zh: ' 我的皮肤 ', en: 'My Skin' },
      author: ' Someone ',
      description: 'Calm and dark.',
      accent: '#AABBCC',
      colorScheme: 'light',
    }))
    expect(skin).toMatchObject({
      name: { zh: '我的皮肤', en: 'My Skin' },
      author: 'Someone',
      description: 'Calm and dark.',
      accent: '#aabbcc',
      colorScheme: 'light',
    })
  })

  it('treats blank author and description as unset', () => {
    const skin = accepted(nativePack({ author: '   ', description: '' }))
    expect(skin).not.toHaveProperty('author')
    expect(skin).not.toHaveProperty('description')
  })

  it('accepts every allowlisted token set one at a time, and rejects the full set by count', () => {
    for (const token of SKINNABLE_TOKENS) {
      expect(accepted(nativePack({ tokens: { ...CORE_VALUES, [token]: '#123456' } })).tokens[token]).toBeDefined()
    }
    const everything = Object.fromEntries(SKINNABLE_TOKENS.map(token => [token, '#123456']))
    expect(SKINNABLE_TOKENS.length).toBeGreaterThan(MAX_PACK_TOKENS)
    expectIssue(nativePack({ tokens: everything }), `at most ${MAX_PACK_TOKENS}`)
    const full = Object.fromEntries(SKINNABLE_TOKENS.slice(0, MAX_PACK_TOKENS).map(token => [token, '#123456']))
    expect(Object.keys(accepted(nativePack({ tokens: full })).tokens)).toHaveLength(MAX_PACK_TOKENS)
  })

  it('accepts gradient backgrounds and round-trips through the serialized form', () => {
    const background = {
      kind: 'gradient',
      layers: [
        { type: 'radial', at: [20, 10], size: 60, stops: [['#5e6ad240', 0], ['transparent', 100]] },
        { type: 'linear', angle: 165, stops: [['#121216', 0], ['#101016', 100]] },
      ],
    }
    const skin = accepted(nativePack({ background, author: 'A', description: 'D', accent: '#010203' }))
    expect(skin.background).toEqual(background)
    const text = serializeSkinPack(skin)
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ format: PACK_FORMAT, version: 1, id: 'my-skin' })
    expect(accepted(text)).toEqual(skin)
    expect(JSON.parse(serializeSkinPack(accepted(nativePack())))).not.toHaveProperty('background')
  })

  it('tolerates a leading byte-order mark', () => {
    expect(accepted(`\uFEFF${JSON.stringify(nativePack())}`).id).toBe('my-skin')
  })

  it('reports invalid JSON and non-object documents', () => {
    expectIssue('{', 'not valid JSON')
    expectIssue('', 'not valid JSON')
    for (const text of ['[]', 'null', '3', '"text"']) expectIssue(text, 'must be a JSON object')
  })

  it('rejects an unknown or missing format and a wrong version', () => {
    expectIssue(nativePack({ format: 'other' }), 'format "other" is not supported')
    expectIssue({ ...nativePack(), format: undefined }, 'format undefined is not supported')
    expectIssue(nativePack({ format: 7 }), 'format number is not supported')
    expectIssue(nativePack({ version: 2 }), 'version must be 1')
    expectIssue(nativePack({ version: '1' }), 'version must be 1')
    expectIssue({ ...nativePack(), version: undefined }, 'version must be 1')
  })

  it('rejects unknown keys instead of dropping them', () => {
    expectIssue(nativePack({ wallpaper: 'x' }), 'pack: unknown key "wallpaper"')
    expectIssue(nativePack({ name: { zh: 'a', en: 'b', fr: 'c' } }), 'name: unknown key "fr"')
    expectIssue(nativePack({ ['x'.repeat(100)]: 1 }), `unknown key "${'x'.repeat(40)}…"`)
  })

  it.each([
    ['uppercase', 'My-Skin'], ['leading dash', '-skin'], ['too long', 'a'.repeat(41)], ['empty', ''], ['underscore', 'my_skin'],
    ['slash', '../escape'], ['number', 7], ['null', null],
  ])('rejects an id that is %s', (_label, id) => {
    expectIssue(nativePack({ id }), 'id must match')
  })

  it('accepts the longest and shortest ids', () => {
    expect(accepted(nativePack({ id: 'a'.repeat(40) })).id).toHaveLength(40)
    expect(accepted(nativePack({ id: '0' })).id).toBe('0')
  })

  it.each(['abyss', 'aurora', 'nebula', 'ember', 'midnight', 'ivory', 'mist', 'rose'])('rejects the built-in id %s', (id) => {
    expectIssue(nativePack({ id }), 'belongs to a built-in skin')
  })

  it('validates names', () => {
    expectIssue(nativePack({ name: '' }), 'name must not be empty')
    expectIssue(nativePack({ name: '   ' }), 'name must not be empty')
    expectIssue(nativePack({ name: 'x'.repeat(61) }), 'name is longer than 60')
    expectIssue(nativePack({ name: 'bad\nname' }), 'name must not contain control characters')
    expectIssue(nativePack({ name: 'bad\u2028name' }), 'name must not contain control characters')
    expectIssue(nativePack({ name: 5 }), 'name must be a string or an object')
    expectIssue(nativePack({ name: ['a'] }), 'name must be a string or an object')
    expectIssue(nativePack({ name: { zh: 'a' } }), 'name.en must be a string')
    expectIssue(nativePack({ name: { en: 'a' } }), 'name.zh must be a string')
    expect(accepted(nativePack({ name: 'x'.repeat(60) })).name.en).toHaveLength(60)
  })

  it('validates author and description limits', () => {
    expectIssue(nativePack({ author: 'a'.repeat(81) }), 'author is longer than 80')
    expectIssue(nativePack({ author: 3 }), 'author must be a string')
    expectIssue(nativePack({ description: 'd'.repeat(241) }), 'description is longer than 240')
    expectIssue(nativePack({ description: 'line\nbreak' }), 'description must not contain control characters')
    expect(accepted(nativePack({ author: 'a'.repeat(80), description: 'd'.repeat(240) }))).toMatchObject({ author: 'a'.repeat(80) })
  })

  it('validates colorScheme and accent', () => {
    expectIssue(nativePack({ colorScheme: 'sepia' }), 'colorScheme must be "light" or "dark"')
    expectIssue({ ...nativePack(), colorScheme: undefined }, 'colorScheme must be')
    expectIssue(nativePack({ accent: '#fff' }), 'accent "#fff" must be a #rrggbb colour')
    expectIssue(nativePack({ accent: 'rgb(1, 2, 3)' }), 'must be a #rrggbb colour')
    expectIssue(nativePack({ accent: 12 }), 'accent number must be a #rrggbb colour')
  })

  it('rejects malformed token tables', () => {
    expectIssue(nativePack({ tokens: [] }), 'tokens must be an object')
    expectIssue(nativePack({ tokens: 'x' }), 'tokens must be an object')
    expectIssue({ ...nativePack(), tokens: undefined }, 'tokens must be an object')
    expectIssue(nativePack({ tokens: { ...CORE_VALUES, '--dsw-unknown': '#fff' } }), 'tokens: "--dsw-unknown" is not a skinnable token')
    expectIssue(nativePack({ tokens: { ...CORE_VALUES, color: '#fff' } }), 'not a skinnable token')
    expectIssue(JSON.stringify(nativePack()).replace('"tokens":{', '"tokens":{"__proto__":"#fff",'), '"__proto__" is not a skinnable token')
  })

  it.each([
    ['url()', 'url(https://example.com/x.png)'],
    ['var()', 'var(--dsw-alias-bg-base)'],
    ['calc()', 'calc(1px + 2px)'],
    ['color-mix()', 'color-mix(in srgb, #fff 50%, transparent)'],
    ['braces', '#fff}body{color:red'],
    ['semicolon', '#fff; color: red'],
    ['bang', '#fff !important'],
    ['quote', '"#fff"'],
    ['backslash', '#fff\\'],
    ['script close', '</script><script>alert(1)</script>'],
    ['named colour', 'red'],
    ['a number', 7],
    ['null', null],
    ['too long', `rgba(${'1, '.repeat(30)}1)`],
  ])('rejects a token value using %s', (_label, value) => {
    expectIssue(nativePack({ tokens: { ...CORE_VALUES, '--dsw-alias-bg-layer-2': value } }), 'token --dsw-alias-bg-layer-2')
  })

  it('names every missing core token', () => {
    const issues = issuesOf(nativePack({ tokens: { '--dsw-alias-bg-base': '#000' } }))
    const missing = issues.find(issue => issue.startsWith('missing required tokens'))!
    for (const token of CORE_TOKENS.filter(token => token !== '--dsw-alias-bg-base')) expect(missing).toContain(token)
    expect(missing).not.toContain('--dsw-alias-bg-base,')
    expectIssue(nativePack({ tokens: {} }), 'missing required tokens')
  })

  it('rejects an oversized pack before parsing it', () => {
    const padded = JSON.stringify(nativePack({ description: 'x'.repeat(MAX_PACK_BYTES) }))
    expect(Buffer.byteLength(padded)).toBeGreaterThan(MAX_PACK_BYTES)
    expectIssue(padded, 'the limit is 262144 bytes')
    const multibyte = `{"x":"${'\u4e2d'.repeat(Math.ceil(MAX_PACK_BYTES / 3))}"}`
    expect(multibyte.length).toBeLessThan(MAX_PACK_BYTES)
    expectIssue(multibyte, 'the limit is 262144 bytes')
  })

  it('reports every violated rule in one pass, capped at twenty', () => {
    const issues = issuesOf(nativePack({ id: 'BAD', name: '', colorScheme: 'x', accent: 'y', unknown: 1 }))
    expect(issues.length).toBeGreaterThanOrEqual(5)
    const tokens = Object.fromEntries(SKINNABLE_TOKENS.slice(0, MAX_PACK_TOKENS).map(token => [token, 'red']))
    expect(issuesOf(nativePack({ tokens }))).toHaveLength(20)
  })
})

describe('gradient backgrounds', () => {
  const linear = { type: 'linear', angle: 90, stops: [['#000', 0], ['#fff', 100]] }
  const radial = { type: 'radial', at: [50, 50], size: 50, stops: [['#000', 0], ['transparent', 100]] }
  const withBackground = (background: unknown): Record<string, unknown> => nativePack({ background })
  const withLayer = (layer: unknown): Record<string, unknown> => withBackground({ kind: 'gradient', layers: [layer] })

  it('accepts the layer and stop ceilings', () => {
    const layers = Array.from({ length: MAX_GRADIENT_LAYERS }, () => linear)
    expect(accepted(withBackground({ kind: 'gradient', layers })).background!.layers).toHaveLength(MAX_GRADIENT_LAYERS)
    const stops = Array.from({ length: MAX_GRADIENT_STOPS }, (_, index) => ['#000', index])
    expect(accepted(withLayer({ ...linear, stops })).background!.layers).toHaveLength(1)
    expect(accepted(withLayer({ ...linear, angle: 360 })).background).toBeDefined()
    expect(accepted(withLayer({ ...radial, at: [0, 100], size: 150 })).background).toBeDefined()
    expect(accepted(withLayer({ ...radial, size: 1 })).background).toBeDefined()
  })

  it('rejects too many layers, too many stops, and too few', () => {
    expectIssue(withBackground({ kind: 'gradient', layers: Array.from({ length: MAX_GRADIENT_LAYERS + 1 }, () => linear) }), 'background.layers must list 1 to 6')
    expectIssue(withBackground({ kind: 'gradient', layers: [] }), 'background.layers must list 1 to 6')
    expectIssue(withBackground({ kind: 'gradient', layers: 'x' }), 'background.layers must list')
    expectIssue(withBackground({ kind: 'gradient' }), 'background.layers must list')
    const stops = Array.from({ length: MAX_GRADIENT_STOPS + 1 }, (_, index) => ['#000', index])
    expectIssue(withLayer({ ...linear, stops }), 'stops must list 2 to 8 stops')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0]] }), 'stops must list 2 to 8 stops')
    expectIssue(withLayer({ ...linear, stops: 'x' }), 'stops must list')
    expectIssue(withLayer({ type: 'linear', angle: 1 }), 'stops must list')
  })

  it('rejects malformed stops', () => {
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], 'x'] }), 'background.layers[0].stops[1] must be [colour, position]')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], ['#fff']] }), 'must be [colour, position]')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], ['#fff', 1, 2]] }), 'must be [colour, position]')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], ['url(x)', 100]] }), 'stops[1] colour "url(x)" is not a supported colour')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], [5, 100]] }), 'stops[1] colour number is not a supported colour')
    expectIssue(withLayer({ ...linear, stops: [['#000', -1], ['#fff', 100]] }), 'stops[0] position must be a number from 0 to 100')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], ['#fff', 101]] }), 'position must be a number from 0 to 100')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], ['#fff', '100']] }), 'position must be a number')
    expectIssue(withLayer({ ...linear, stops: [['#000', 0], ['#fff', null]] }), 'position must be a number')
  })

  it('rejects malformed layers', () => {
    expectIssue(withLayer('x'), 'background.layers[0] must be an object')
    expectIssue(withLayer({ ...linear, type: 'conic' }), 'background.layers[0].type must be "linear" or "radial"')
    expectIssue(withLayer({ ...linear, extra: 1 }), 'background.layers[0]: unknown key "extra"')
    expectIssue(withLayer({ ...radial, angle: 1 }), 'unknown key "angle"')
    expectIssue(withLayer({ ...linear, angle: -1 }), 'angle must be a number from 0 to 360')
    expectIssue(withLayer({ ...linear, angle: 361 }), 'angle must be a number from 0 to 360')
    expectIssue(withLayer({ ...linear, angle: '90' }), 'angle must be a number')
    expectIssue(withLayer({ ...linear, angle: null }), 'angle must be a number')
    expectIssue(withLayer({ ...radial, at: [50] }), 'at must be [x, y]')
    expectIssue(withLayer({ ...radial, at: 'x' }), 'at must be [x, y]')
    expectIssue(withLayer({ ...radial, at: [101, 0] }), 'at[0] must be a number from 0 to 100')
    expectIssue(withLayer({ ...radial, at: [0, -1] }), 'at[1] must be a number from 0 to 100')
    expectIssue(withLayer({ ...radial, size: 0 }), 'size must be a number from 1 to 150')
    expectIssue(withLayer({ ...radial, size: 151 }), 'size must be a number from 1 to 150')
    expectIssue(withLayer({ ...radial, size: 'big' }), 'size must be a number')
  })

  it('rejects a malformed background object', () => {
    expectIssue(withBackground('x'), 'background must be an object')
    expectIssue(withBackground([]), 'background must be an object')
    expectIssue(withBackground({ kind: 'image', layers: [linear] }), 'background.kind must be "gradient"')
    expectIssue(withBackground({ kind: 'gradient', layers: [linear], url: 'x' }), 'background: unknown key "url"')
  })
})

describe('dsh-dream-skin compatibility', () => {
  it('converts a dream-skin pack: lowercased id, names, and an accent family derived from the brand colour', () => {
    expect(accepted(dreamPack())).toEqual({
      id: 'aurora-test',
      source: 'pack',
      name: { zh: '极光测试', en: 'Aurora Test' },
      colorScheme: 'dark',
      tokens: {
        '--dsw-accent': '#34d399',
        '--dsw-alias-bg-base': '#101014',
        '--dsw-alias-bg-layer-1': '#1b1e28',
        '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.07)',
        '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
        '--dsw-alias-label-primary': '#f4f5f7',
        '--dsw-alias-label-secondary': '#a5adb8',
        '--dsw-alias-brand-primary': '#34d399',
      },
    })
    expect(Object.keys(accepted(dreamPack()).tokens)[0]).toBe('--dsw-accent')
  })

  it('prefers the manifest accent and derives hover and soft from the accent-meaning tokens', () => {
    const skin = accepted(dreamPack({
      accent: '#112233',
      author: 'RevolutionLA',
      description: 'A calm aurora dark theme.',
      tokens: {
        ...Object.fromEntries(Object.entries(CORE_VALUES).filter(([name]) => name !== '--dsw-accent')),
        '--dsw-alias-brand-primary': '#34d399',
        '--dsw-alias-button-primary-hover': '#44e0a9',
        '--dsw-alias-button-primary-dimmed': 'rgba(52, 211, 153, 0.14)',
      },
    }))
    expect(skin.accent).toBe('#112233')
    expect(skin.author).toBe('RevolutionLA')
    expect(skin.tokens).toMatchObject({
      '--dsw-accent': '#112233',
      '--dsw-accent-hover': '#44e0a9',
      '--dsw-accent-soft': 'rgba(52, 211, 153, 0.14)',
    })
  })

  it('keeps explicit accent-family tokens and the manifest accent over the derived values', () => {
    const skin = accepted(dreamPack({
      accent: '#112233',
      tokens: {
        ...CORE_VALUES,
        '--dsw-accent': '#445566',
        '--dsw-accent-hover': '#556677',
        '--dsw-accent-soft': '#66778899',
        '--dsw-alias-button-primary-hover': '#000000',
      },
    }))
    expect(skin.tokens).toMatchObject({ '--dsw-accent': '#445566', '--dsw-accent-hover': '#556677', '--dsw-accent-soft': '#66778899' })
  })

  it('drops tokens outside the allowlist without error and without counting them', () => {
    const extras = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`--dream-extra-${index}`, '#123456']))
    const skin = accepted(dreamPack({
      tokens: {
        ...CORE_VALUES,
        ...extras,
        '--dsw-alias-state-business-primary': '#34d399',
        '--dsw-alias-markdown-tag': 'not even a colour',
      },
    }))
    expect(Object.keys(skin.tokens)).toEqual(SKINNABLE_TOKENS.filter(token => token in CORE_VALUES))
  })

  it('still validates allowlisted token values and the 40-token ceiling', () => {
    expectIssue(dreamPack({ tokens: { ...CORE_VALUES, '--dsw-alias-bg-layer-2': 'url(x)' } }), 'token --dsw-alias-bg-layer-2')
    const everything = Object.fromEntries(SKINNABLE_TOKENS.map(token => [token, '#123456']))
    expectIssue(dreamPack({ tokens: everything }), `at most ${MAX_PACK_TOKENS}`)
  })

  it('requires the core tokens, including a derivable accent', () => {
    const { '--dsw-alias-brand-primary': _brand, ...withoutBrand } = (dreamPack().manifest as { tokens: Record<string, string> }).tokens
    expectIssue(dreamPack({ tokens: withoutBrand }), 'missing required tokens: --dsw-accent')
    expectIssue(dreamPack({ tokens: {} }), 'missing required tokens')
    expectIssue(dreamPack({ tokens: 'x' }), 'tokens must be an object')
  })

  it('names the skin from whichever of name and nameZh is present', () => {
    expect(accepted(dreamPack({ nameZh: undefined })).name).toEqual({ zh: 'Aurora Test', en: 'Aurora Test' })
    expect(accepted(dreamPack({ name: undefined })).name).toEqual({ zh: '极光测试', en: '极光测试' })
    expectIssue(dreamPack({ name: undefined, nameZh: undefined }), 'manifest.name or manifest.nameZh is required')
    expectIssue(dreamPack({ name: 5 }), 'name.en must be a string')
  })

  it('validates the manifest envelope and fields', () => {
    expectIssue(dreamPack({}, { manifest: 'x' }), 'manifest must be an object')
    expectIssue(dreamPack({}, { manifest: undefined }), 'manifest must be an object')
    expectIssue(dreamPack({}, { version: 2 }), 'version must be 1')
    expectIssue(dreamPack({ id: 'bad id' }), 'id must match')
    expectIssue(dreamPack({ id: 12 }), 'id must match')
    expectIssue(dreamPack({ id: 'AbYsS' }), 'belongs to a built-in skin')
    expectIssue(dreamPack({ colorScheme: 'sepia' }), 'colorScheme must be')
    expectIssue(dreamPack({ accent: 'teal' }), 'accent "teal" must be a #rrggbb colour')
    expectIssue(dreamPack({ author: 'a'.repeat(81) }), 'author is longer than 80')
  })

  it('ignores manifest keys it does not know, such as the pack version', () => {
    expect(accepted(dreamPack({ version: '1.0.0', wallpaper: 'x', tags: ['a'] })).id).toBe('aurora-test')
  })
})
