import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {} }))
import { smokeReportPath, assertEmptyCommandPath, rendererReady, boundedSmokeStep } from '../src/smoke.ts'

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

it('fails a lifecycle step that parks past its budget instead of waiting forever', async () => {
  vi.useFakeTimers()
  try {
    const promise = boundedSmokeStep('disconnect', 1000, () => new Promise<never>(() => {}))
    const assertion = expect(promise).rejects.toThrow("step 'disconnect' did not settle within 1000ms")
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  }
  finally { vi.useRealTimers() }
})

it('keeps a step that settles inside its budget and its own rejection intact', async () => {
  vi.useFakeTimers()
  try {
    const value = await boundedSmokeStep('connect', 1000, async () => 'ready')
    expect(value).toBe('ready')
    await expect(boundedSmokeStep('connect', 1000, () => Promise.reject(new Error('shell refused')))).rejects.toThrow('shell refused')
    expect(vi.getTimerCount()).toBe(0)
  }
  finally { vi.useRealTimers() }
})
