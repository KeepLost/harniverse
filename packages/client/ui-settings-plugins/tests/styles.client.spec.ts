/**
 * Stylesheet contract of the plugin settings cards, asserted against the CSS
 * text on disk.
 *
 * The plugin bundler keeps only each class's own name in the exported map, so a
 * `composes` rule compiles and loads yet silently drops the composed rules from
 * the element: nothing downstream reports it, and the control paints half-styled.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
const sheets = readdirSync(clientDir)
  .filter(name => name.endsWith('.module.css'))
  .map(name => ({ name, text: readFileSync(`${clientDir}${name}`, 'utf8') }))

describe('plugin settings stylesheets', () => {
  it('reads at least the field and card sheets', () => {
    expect(sheets.map(sheet => sheet.name)).toEqual(
      expect.arrayContaining(['fields.module.css', 'PluginCard.module.css']),
    )
  })

  it('never relies on `composes`, which the plugin bundler drops', () => {
    const composing = sheets
      .filter(sheet => /^\s*composes\s*:/m.test(sheet.text.replace(/\/\*[\s\S]*?\*\//g, '')))
      .map(sheet => sheet.name)
    expect(composing).toEqual([])
  })

  it('keeps the invalid marker a standalone border colour', () => {
    const fields = sheets.find(sheet => sheet.name === 'fields.module.css')?.text ?? ''
    const rule = /^\.inputInvalid,?[^{]*\{([^}]*)\}/m.exec(fields)?.[1] ?? ''
    expect(rule.trim()).toBe('border-color: var(--dsw-alias-state-error-primary);')
  })
})
