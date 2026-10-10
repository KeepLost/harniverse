/** The pre-plugin boot script: preference parsing, safe embedding, re-validation, and placement. */

import { runInNewContext } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { embedJson, injectBootSkin, readThemePreference, skinIdOfPreference } from '../src/boot.ts'
import { BUILTIN_SKINS } from '../src/palette.ts'
import { SKINNABLE_TOKENS } from '../src/pack.ts'
import type { SkinDefinition } from '../src/types.ts'

const abyss = BUILTIN_SKINS[0]!
const ivory = BUILTIN_SKINS.find(skin => skin.id === 'ivory')!

const SCRIPT = /<script>([\s\S]*?)<\/script>/

/** Run the injected script against a recording DOM stand-in. */
function execute(html: string): {
  colorScheme: string | undefined
  dark: boolean | undefined
  properties: Record<string, string>
  attributes: Record<string, string>
} {
  const source = SCRIPT.exec(html)![1]!
  const seen = {
    colorScheme: undefined as string | undefined,
    dark: undefined as boolean | undefined,
    properties: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
  }
  const document = {
    documentElement: { style: { set colorScheme(value: string) { seen.colorScheme = value } } },
    body: {
      toggleAttribute(name: string, force: boolean) {
        expect(name).toBe('data-ds-dark-theme')
        seen.dark = force
      },
      setAttribute(name: string, value: string) { seen.attributes[name] = value },
      style: { setProperty(name: string, value: string) { seen.properties[name] = value } },
    },
  }
  runInNewContext(source, { document })
  return seen
}

describe('skinIdOfPreference', () => {
  it('extracts the id of a skin preference', () => {
    expect(skinIdOfPreference('skin:abyss')).toBe('abyss')
    expect(skinIdOfPreference('skin:my-skin-2')).toBe('my-skin-2')
    expect(skinIdOfPreference(`skin:${'a'.repeat(40)}`)).toBe('a'.repeat(40))
  })

  it.each([
    'light', 'dark', 'system', '', 'skin:', 'skin:Abyss', 'skin:-x', 'skin:a b', 'skin:a/b', 'skin:../x', `skin:${'a'.repeat(41)}`,
    'Skin:abyss', 'theme:abyss', ' skin:abyss', 'skin:abyss ', 'skin:abyss\n',
  ])('ignores %j', (preference) => {
    expect(skinIdOfPreference(preference)).toBeUndefined()
  })

  it('ignores non-string preferences', () => {
    for (const value of [undefined, null, 3, {}, ['skin:abyss']]) expect(skinIdOfPreference(value)).toBeUndefined()
  })
})

describe('readThemePreference', () => {
  function context(settings: unknown): Context {
    return { get: (name: string) => (name === 'settings' ? settings : undefined) } as unknown as Context
  }

  it('reads the stored ui-theme preference through the settings service', () => {
    const reads: unknown[] = []
    const settings = { get: (namespace: unknown) => { reads.push(namespace); return { preference: 'skin:abyss', fontSize: 16 } } }
    expect(readThemePreference(context(settings))).toBe('skin:abyss')
    expect(reads).toEqual(['ui-theme'])
  })

  it('is undefined without a settings service or a registered theme section', () => {
    expect(readThemePreference(context(undefined))).toBeUndefined()
    expect(readThemePreference(context({ get: () => undefined }))).toBeUndefined()
    expect(readThemePreference(context({ get: () => null }))).toBeUndefined()
    expect(readThemePreference(context({ get: () => 'dark' }))).toBeUndefined()
    expect(readThemePreference(context({ get: () => ({ fontSize: 16 }) }))).toBeUndefined()
  })
})

describe('embedJson', () => {
  it('escapes every character that could end a script or a JS string early', () => {
    const value = { text: '</script><!-- & \u2028 \u2029 </SCRIPT>', 'k</script>': ['>'] }
    const text = embedJson(value)
    for (const raw of ['<', '>', '&', '\u2028', '\u2029']) expect(text).not.toContain(raw)
    expect(text).toContain('\\u003c/script\\u003e')
    expect(text).toContain('\\u2028')
    expect(JSON.parse(text)).toEqual(value)
  })

  it('leaves safe JSON untouched', () => {
    expect(embedJson({ a: ['b', 1, true, null] })).toBe('{"a":["b",1,true,null]}')
  })
})

describe('injectBootSkin', () => {
  it('inserts one script immediately before the closing body tag that applies the skin', () => {
    const html = '<html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>'
    const out = injectBootSkin(html, abyss)
    expect(out.startsWith('<html><body><div id="app"></div><script type="module" src="/main.js"></script><script>')).toBe(true)
    expect(out.endsWith('</script></body></html>')).toBe(true)
    expect(out.match(/<script>/g)).toHaveLength(1)
    const seen = execute(out)
    expect(seen.colorScheme).toBe('dark')
    expect(seen.dark).toBe(true)
    expect(seen.properties).toEqual(abyss.tokens)
    expect(Object.keys(seen.properties)).toEqual(SKINNABLE_TOKENS.filter(token => token in abyss.tokens))
  })

  it('hands the written variable names to the client presenter through a body attribute', () => {
    const seen = execute(injectBootSkin('<body></body>', abyss))
    expect(seen.attributes).toEqual({ 'data-ds-boot-tokens': Object.keys(seen.properties).join(' ') })
  })

  it('marks a light skin as light', () => {
    const seen = execute(injectBootSkin('<body></body>', ivory))
    expect(seen).toMatchObject({ colorScheme: 'light', dark: false })
    expect(seen.properties['--dsw-accent']).toBe('#0071e3')
  })

  it('is deterministic', () => {
    const html = '<body>x</body>'
    expect(injectBootSkin(html, abyss)).toBe(injectBootSkin(html, abyss))
  })

  it('places the script before the last closing body tag, whatever its case or spacing', () => {
    const html = '<body><!-- </body> --><p>x</p></BODY ></html>'
    const out = injectBootSkin(html, abyss)
    expect(out.indexOf('<script>')).toBeGreaterThan(out.indexOf('<p>x</p>'))
    expect(out.endsWith('</script></BODY ></html>')).toBe(true)
  })

  it('appends to a fragment that has no body tag', () => {
    const out = injectBootSkin('<div>fragment</div>', abyss)
    expect(out.startsWith('<div>fragment</div><script>')).toBe(true)
    expect(out.endsWith('</script>')).toBe(true)
  })

  it('omits tokens that are not allowlisted or fail the colour grammar, so nothing can break out of the script', () => {
    const hostile: SkinDefinition = {
      ...abyss,
      tokens: {
        ...abyss.tokens,
        '--dsw-alias-bg-layer-2': '</script><script>alert(1)</script>',
        '--dsw-alias-bg-layer-3': 'url(https://example.com/beacon.png)',
        '--dsw-alias-bg-overlay': '#fff;}body{display:none',
        '--dsw-specific-tip': 'var(--dsw-alias-bg-base)',
        '--evil': '#ffffff',
        '--dsw-alias-label-caption': '#fff\u2028',
      },
    }
    const out = injectBootSkin('<body></body>', hostile)
    expect(out).not.toContain('alert')
    expect(out).not.toContain('beacon')
    expect(out).not.toContain('--evil')
    expect(out).not.toContain('display:none')
    expect(out.match(/<\/script>/g)).toHaveLength(1)
    const { properties } = execute(out)
    for (const dropped of ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay', '--dsw-specific-tip', '--evil', '--dsw-alias-label-caption']) {
      expect(properties, dropped).not.toHaveProperty(dropped)
    }
    expect(properties['--dsw-alias-bg-base']).toBe('#101014')
  })

  it('emits an empty token set for a skin whose tokens all fail validation', () => {
    const empty: SkinDefinition = { ...abyss, tokens: { '--dsw-accent': 'red' } }
    expect(execute(injectBootSkin('<body></body>', empty)).properties).toEqual({})
  })
})
