import { describe, expect, it } from 'vitest'
import { exportPack, PACK_FORMAT, PACK_VERSION } from '../src/client/pack.ts'
import { GRADIENT, skin } from './fixtures.client.ts'

describe('pack export', () => {
  it('exports an imported pack under its own id so re-import replaces it', () => {
    const exported = exportPack(skin('my-skin', {
      source: 'pack', author: 'Ada', description: 'Quiet blues', accent: '#112233', background: GRADIENT,
    }))
    expect(exported.fileName).toBe('my-skin.json')
    expect(exported.text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(exported.text)).toEqual({
      format: PACK_FORMAT,
      version: PACK_VERSION,
      id: 'my-skin',
      name: { zh: 'my-skin中文', en: 'my-skin en' },
      author: 'Ada',
      description: 'Quiet blues',
      colorScheme: 'dark',
      accent: '#112233',
      tokens: skin('x').tokens,
      background: GRADIENT,
    })
    expect(Object.keys(JSON.parse(exported.text) as object)).toEqual([
      'format', 'version', 'id', 'name', 'author', 'description', 'colorScheme', 'accent', 'tokens', 'background',
    ])
  })

  it('exports a built-in as an editable copy under a free id', () => {
    const exported = exportPack(skin('abyss', { accent: undefined }))
    const document = JSON.parse(exported.text) as Record<string, unknown>
    expect(exported.fileName).toBe('abyss-copy.json')
    expect(document.id).toBe('abyss-copy')
    expect(document.name).toEqual({ zh: 'abyss中文（副本）', en: 'abyss en (copy)' })
    for (const optional of ['author', 'description', 'accent', 'background']) expect(document).not.toHaveProperty(optional)
  })

  it('keeps a copied id inside the 40-character id limit', () => {
    const long = 'x'.repeat(40)
    const exported = exportPack(skin(long))
    expect(JSON.parse(exported.text)).toMatchObject({ id: `${'x'.repeat(35)}-copy` })
    expect((JSON.parse(exported.text) as { id: string }).id).toHaveLength(40)
  })
})
