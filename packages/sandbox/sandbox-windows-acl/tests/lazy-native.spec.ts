import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import '../src/index.ts'

const require = createRequire(import.meta.url)

/** Whether one native dependency's module is present in the require cache. */
function nativeLoaded(name: string): boolean {
  const entry = require.resolve(name)
  const marker = entry.slice(0, entry.indexOf('/node_modules/') + '/node_modules/'.length)
  const root = marker + name + '/'
  return Object.keys(require.cache).some(path => path.startsWith(root))
}

describe('sandbox-windows-acl lazy koffi', () => {
  it('loads no koffi addon at import', () => {
    expect(nativeLoaded('koffi')).toBe(false)
  })
})
