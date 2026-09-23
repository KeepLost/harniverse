import { afterEach, describe, expect, it, vi } from 'vitest'
import { childSpawnPlan } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('child bootstrap selection', () => {
  const config = { nodeExecutable: process.execPath, maxOldGenerationSizeMb: 128 }

  function electronHost(): void {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, electron: '42.0.0' } })
  }

  it('boots an Electron self executable as Node with only the required bootstrap variable', () => {
    electronHost()
    const plan = childSpawnPlan(config, false)
    expect(plan.argv).toEqual([process.execPath, '--max-old-space-size=128', expect.stringMatching(/child\.ts$/)])
    expect(plan.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('keeps the Electron bootstrap selection with an explicit built entry', () => {
    electronHost()
    expect(childSpawnPlan({ ...config, bootstrapPath: '/runtime/child.cjs' }, false)).toEqual({
      argv: [process.execPath, '--max-old-space-size=128', '/runtime/child.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('respects a separate genuine Node executable without Electron variables', () => {
    electronHost()
    expect(childSpawnPlan({ ...config, nodeExecutable: '/standalone/node', bootstrapPath: '/runtime/child.cjs' }, false)).toEqual({
      argv: ['/standalone/node', '--max-old-space-size=128', '/runtime/child.cjs'], env: {},
    })
  })

  it('uses an explicit Node and bootstrap pair instead of the packaged self route', () => {
    expect(childSpawnPlan({ ...config, nodeExecutable: '/standalone/node', bootstrapPath: '/runtime/child.cjs' }, true)).toEqual({
      argv: ['/standalone/node', '--max-old-space-size=128', '/runtime/child.cjs'], env: {},
    })
  })
})
