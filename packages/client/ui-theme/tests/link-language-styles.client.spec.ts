/**
 * Link-language stylesheet contract, asserted against the CSS text on disk:
 * design-platform.css owns the dedicated `--dsw-alias-link` token (light
 * deepseek-500, dark deepseek-400 — decoupled from state-business-primary so
 * link color and action color can diverge), every clickable-link surface
 * consumes it with font-weight 500 and a dotted 3px-offset underline reserved
 * for hover/focus, and the secondary font tier (`--dsw-font-xs-13` /
 * `--dsw-font-xxs-12` / `--dsw-font-xxxs-11` families) stays defined for the
 * caption/meta layers. Declarations are pinned per consumer file so a rename
 * or drift in any one surface fails next to its selector.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** One flattened CSS rule: its comma-separated selector parts and its declarations in source order. */
interface CssRule {
  selectors: string[]
  declarations: [property: string, value: string][]
}

const STYLES = new URL('../src/styles/', import.meta.url)
const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, STYLES)), 'utf8')

const platformCss = read('design-platform.css')
const typeCss = read('gradient-shadow-text.css')

/** Body attribute selecting the dark palette; ui-layout's ThemePresenter sets it. */
const DARK_ATTRIBUTE = '[data-ds-dark-theme]'
/** The link-color token this contract pins. */
const LINK_TOKEN = '--dsw-alias-link'

/**
 * Flatten a stylesheet into rules. Whitespace, declaration order, and trailing
 * semicolons are normalized away; nesting and at-rules are not handled, which
 * no sheet under test uses for the declarations asserted here.
 * @param css - stylesheet text.
 * @returns one entry per rule, in source order.
 */
function parseRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: CssRule[] = []
  // Destructuring defaults only satisfy noUncheckedIndexedAccess; both groups
  // are unconditional in the pattern.
  for (const [, selector = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = body
      .split(';')
      .map(part => part.trim())
      .filter(part => part.includes(':'))
      .map((part): [string, string] => {
        const colon = part.indexOf(':')
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
      })
    rules.push({ selectors: selector.split(',').map(part => part.trim()), declarations })
  }
  return rules
}

/** Custom-property names a value reads. @param value - declaration value. @returns every referenced custom-property name. */
function varReferences(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name = '']) => name)
}

/**
 * Declarations of every rule whose selector list contains the selector, from
 * one stylesheet on disk.
 * @param relative - path under packages/client/ of the css module.
 * @param selector - exact selector part to match.
 */
function declarationsOf(relative: string, selector: string): [string, string][] {
  const css = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  return parseRules(css)
    .filter(rule => rule.selectors.includes(selector))
    .flatMap(rule => rule.declarations)
}

/**
 * Every CSS file shipped as package source, excluding build output and
 * installed dependencies.
 * @returns absolute paths of the stylesheets under packages/.
 */
function packageStylesheets(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist') walk(path)
      } else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(PACKAGES_DIR)
  return found
}

const platformRules = parseRules(platformCss)

/**
 * Custom-property definitions from the rules whose selectors carry (or do not
 * carry) the dark palette attribute.
 * @param dark - true to scan the dark blocks, false to scan the light blocks.
 */
function aliasDefinitions(dark: boolean): Map<string, string> {
  const definitions = new Map<string, string>()
  for (const rule of platformRules) {
    if (rule.selectors.every(selector => selector.includes(DARK_ATTRIBUTE)) !== dark) continue
    for (const [property, value] of rule.declarations) {
      if (property.startsWith('--')) definitions.set(property, value)
    }
  }
  return definitions
}

describe('design-platform.css link token', () => {
  it('defines --dsw-alias-link in both palettes at the brand-blue rungs', () => {
    expect(aliasDefinitions(false).get(LINK_TOKEN)).toBe('var(--dsw-static-deepseek-500)')
    expect(aliasDefinitions(true).get(LINK_TOKEN)).toBe('var(--dsw-static-deepseek-400)')
  })

  it('resolves the link token to a static scale value, not to another alias', () => {
    // The alias layer is the only indirection in the token sheet: an alias
    // pointing at a second alias makes the dark override order-dependent.
    for (const definitions of [aliasDefinitions(false), aliasDefinitions(true)]) {
      for (const reference of varReferences(definitions.get(LINK_TOKEN) ?? '')) {
        expect(reference).toMatch(/^--dsw-static-/)
      }
    }
  })
})

describe('secondary font tier tokens', () => {
  const typeRules = parseRules(typeCss)
  const bodyDefinitions = new Map<string, string>(
    typeRules.filter(rule => rule.selectors.includes('body')).flatMap(rule => rule.declarations),
  )

  it.each([
    ['--dsw-font-xs-13', '13px/20px'],
    ['--dsw-font-xs-strong-13', '500 13px/20px'],
    ['--dsw-font-xxs-12', '12px/18px'],
    ['--dsw-font-xxs-strong-12', '500 12px/18px'],
    ['--dsw-font-xxxs-11', '11px/14px'],
    ['--dsw-font-xxxs-strong-11', '500 11px/14px'],
  ])('defines %s as %s on the app font stack', (token, size) => {
    expect(bodyDefinitions.get(token)).toBe(`${size} var(--dsw-font-family)`)
    expect(bodyDefinitions.get(`${token}-font-size`)).toBe(size.replace(/^500 /, '').split('/')[0])
    expect(bodyDefinitions.get(`${token}-line-height`)).toBe(size.replace(/^500 /, '').split('/')[1]!)
  })
})

const MARKDOWN_CSS = '../../ui-primitives/src/markdown/MarkdownText.module.css'
const WEBBLOCK_CSS = '../../ui-primitives/src/WebBlock.module.css'
const PRODUCED_CSS = '../../ui-deliverables/src/client/ProducedFiles.module.css'
const WORKFLOW_CSS = '../../ui-workflow-run/src/client/WorkflowRunPanel.module.css'
const TRAJECTORY_CSS = '../../ui-trajectory/src/client/TrajectoryTable.module.css'

describe('markdown anchors and file mentions', () => {
  it('anchors rest in link color at weight 500 with no underline', () => {
    expect(declarationsOf(MARKDOWN_CSS, '.markdown a')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
      ['font-weight', '500'],
      ['text-decoration', 'none'],
    ] as [string, string][]))
  })

  it('anchors underline dotted on hover and focus together', () => {
    expect(declarationsOf(MARKDOWN_CSS, '.markdown a:hover')).toEqual(expect.arrayContaining([
      ['text-decoration', `underline dotted var(${LINK_TOKEN})`],
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
    expect(declarationsOf(MARKDOWN_CSS, '.markdown a:focus')).toEqual(expect.arrayContaining([
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
  })

  it('file mentions share the anchor language', () => {
    expect(declarationsOf(MARKDOWN_CSS, '.fileMention')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
      ['font-weight', '500'],
      ['text-decoration', 'none'],
    ] as [string, string][]))
    expect(declarationsOf(MARKDOWN_CSS, '.fileMention:hover')).toEqual(expect.arrayContaining([
      ['text-decoration', `underline dotted var(${LINK_TOKEN})`],
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
  })

  it('the leading link glyph seats beside the text at 1.1em', () => {
    expect(declarationsOf(MARKDOWN_CSS, '.linkIcon')).toEqual(expect.arrayContaining([
      ['width', '1.1em'],
      ['height', '1.1em'],
      ['vertical-align', '-0.25em'],
    ] as [string, string][]))
  })
})

describe('web source and fetch links', () => {
  it('source links rest in link color at weight 500 with no underline', () => {
    expect(declarationsOf(WEBBLOCK_CSS, '.sourceLink')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
      ['font-weight', '500'],
      ['text-decoration', 'none'],
    ] as [string, string][]))
  })

  it('source links underline dotted on hover and focus-visible together', () => {
    expect(declarationsOf(WEBBLOCK_CSS, '.sourceLink:hover')).toEqual(expect.arrayContaining([
      ['text-decoration', 'underline dotted'],
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
    expect(declarationsOf(WEBBLOCK_CSS, '.sourceLink:focus-visible')).toEqual(expect.arrayContaining([
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
  })

  it('fetch urls share the source-link language', () => {
    expect(declarationsOf(WEBBLOCK_CSS, '.fetchUrl')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
      ['font-weight', '500'],
      ['text-decoration', 'none'],
    ] as [string, string][]))
    expect(declarationsOf(WEBBLOCK_CSS, '.fetchUrl:hover')).toEqual(expect.arrayContaining([
      ['text-decoration', 'underline dotted'],
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
  })
})

describe('produced-file chips', () => {
  it('chips rest in link color at weight 500 with no underline', () => {
    expect(declarationsOf(PRODUCED_CSS, '.file')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
      ['font-weight', '500'],
      ['text-decoration', 'none'],
    ] as [string, string][]))
  })

  it('chips underline dotted on hover and focus-visible together', () => {
    expect(declarationsOf(PRODUCED_CSS, '.file:hover')).toEqual(expect.arrayContaining([
      ['text-decoration', 'underline dotted'],
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
    expect(declarationsOf(PRODUCED_CSS, '.file:focus-visible')).toEqual(expect.arrayContaining([
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
  })

  it('the leading glyph holds the chip edge while the name ellipsizes', () => {
    expect(declarationsOf(PRODUCED_CSS, '.fileIcon')).toEqual(expect.arrayContaining([
      ['flex', 'none'],
      ['width', '1.1em'],
      ['height', '1.1em'],
    ] as [string, string][]))
    expect(declarationsOf(PRODUCED_CSS, '.fileName')).toEqual(expect.arrayContaining([
      ['min-width', '0'],
      ['overflow', 'hidden'],
      ['text-overflow', 'ellipsis'],
      ['white-space', 'nowrap'],
    ] as [string, string][]))
  })
})

describe('workflow member links', () => {
  it('member labels rest in link color at weight 500 with no underline', () => {
    expect(declarationsOf(WORKFLOW_CSS, '.memberButton .memberLabel')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
      ['font-weight', '500'],
      ['text-decoration', 'none'],
    ] as [string, string][]))
  })

  it('member labels underline dotted on hover and keyboard focus together', () => {
    expect(declarationsOf(WORKFLOW_CSS, '.memberButton:hover .memberLabel')).toEqual(expect.arrayContaining([
      ['text-decoration', 'underline dotted'],
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
    expect(declarationsOf(WORKFLOW_CSS, '.memberButton:focus-visible .memberLabel')).toEqual(expect.arrayContaining([
      ['text-underline-offset', '3px'],
    ] as [string, string][]))
  })
})

describe('trajectory subagent links', () => {
  it('the subagent link rides the link token', () => {
    expect(declarationsOf(TRAJECTORY_CSS, '.subagentLink')).toEqual(expect.arrayContaining([
      ['color', `var(${LINK_TOKEN})`],
    ] as [string, string][]))
  })
})

describe('link token consumers', () => {
  it('every package reference to the link token resolves to the defined token', () => {
    // A dangling var() renders the UA default instead of failing loudly, so a
    // rename has to move the reference and the definition together, and every
    // reference must be the token design-platform.css actually defines.
    const uiThemeStyles = fileURLToPath(new URL('.', STYLES))
    let outsideReferences = 0
    for (const file of packageStylesheets()) {
      const inTheme = file.startsWith(uiThemeStyles)
      for (const rule of parseRules(readFileSync(file, 'utf8'))) {
        for (const [, value] of rule.declarations) {
          if (!varReferences(value).includes(LINK_TOKEN)) continue
          if (!inTheme) outsideReferences += 1
          expect([...aliasDefinitions(false).keys()], file).toContain(LINK_TOKEN)
        }
      }
    }
    expect(outsideReferences, 'consumers outside ui-theme').toBeGreaterThan(0)
  })
})
