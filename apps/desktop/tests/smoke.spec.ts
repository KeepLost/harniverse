import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {} }))
import { smokeReportPath, assertEmptyCommandPath, rendererReady } from '../src/smoke.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('enables smoke only with both the explicit flag and an absolute report destination', () => {
  expect(smokeReportPath([], { HARNIVERSE_DESKTOP_SMOKE_REPORT: '/tmp/receipt.json' })).toBeUndefined()
  expect(smokeReportPath(['--harniverse-clean-install-smoke'], {})).toBeUndefined()
  expect(smokeReportPath(['--harniverse-clean-install-smoke'], { HARNIVERSE_DESKTOP_SMOKE_REPORT: '/tmp/receipt.json' })).toBe('/tmp/receipt.json')
  expect(() => smokeReportPath(['--harniverse-clean-install-smoke'], { HARNIVERSE_DESKTOP_SMOKE_REPORT: 'relative.json' })).toThrow('absolute')
})

it('requires one empty command directory instead of accepting ambient executable search paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-smoke-path-'))
  temporary.push(root)
  const path = join(root, 'empty')
  mkdirSync(path)
  expect(() => { assertEmptyCommandPath(path) }).not.toThrow()
  expect(() => { assertEmptyCommandPath(undefined) }).toThrow('empty command')
  writeFileSync(join(path, 'node'), '')
  expect(() => { assertEmptyCommandPath(path) }).toThrow('empty command')
})

it('waits for the authenticated plugin app to render after the normal reload', () => {
  const ready = { authenticated: true, criticalPluginsReady: true, rendered: true }
  expect(rendererReady(ready)).toBe(true)
  for (const key of Object.keys(ready)) expect(rendererReady({ ...ready, [key]: false })).toBe(false)
  expect(rendererReady({})).toBe(false)
  expect(rendererReady(null)).toBe(false)
})
