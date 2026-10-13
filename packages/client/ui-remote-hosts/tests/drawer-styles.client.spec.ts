/**
 * Remote-hosts editor drawer contract, asserted against the CSS text on disk:
 * the drawer's field rule applies to text-like inputs only, so the checkboxes
 * in the form keep their native box and focus ring instead of inheriting the
 * field padding, border, and fill. (The view's `bg-base` fill and the drawer
 * itself sit on the center-view layer, which is opaque by design.)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Declarations of every rule whose selector list contains the exact selector.
 * @param relative - stylesheet path relative to this spec.
 * @param selector - exact selector text.
 * @returns the merged declarations keyed by property, whitespace collapsed.
 */
function declarations(relative: string, selector: string): Map<string, string> {
  const css = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

const REMOTE_HOSTS = '../src/client/remote-hosts.module.css'
const TEXT_LIKE = ".drawerBody input:where(:not([type='checkbox']):not([type='radio']))"

describe('remote-hosts.module.css drawer fields', () => {
  it('styles text-like inputs, selects, and textareas as fields', () => {
    const field = declarations(REMOTE_HOSTS, TEXT_LIKE)
    expect(field.get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
    expect(field.get('padding')).toBe('7px 8px')
    expect(field.get('background')).toBe('var(--dsw-alias-bg-base)')
    expect(declarations(REMOTE_HOSTS, '.drawerBody select').get('border')).toBe('1px solid var(--dsw-alias-border-l2)')
    expect(declarations(REMOTE_HOSTS, '.drawerBody textarea').get('min-height')).toBe('96px')
  })

  it('does not apply the field rule to a bare `input`, which would reach checkboxes', () => {
    expect(declarations(REMOTE_HOSTS, '.drawerBody input').size).toBe(0)
    expect(declarations(REMOTE_HOSTS, '.drawerBody input:focus-visible').size).toBe(0)
  })

  it('keeps the focus ring rule on the same text-like selector', () => {
    const focus = declarations(REMOTE_HOSTS, `${TEXT_LIKE}:focus-visible`)
    expect(focus.get('border-color')).toBe('var(--dsw-alias-brand-primary)')
    expect(focus.get('outline')).toBe('none')
  })

  it('sizes the checkbox through its own rule', () => {
    expect(declarations(REMOTE_HOSTS, '.checkbox input').get('width')).toBe('14px')
  })
})
