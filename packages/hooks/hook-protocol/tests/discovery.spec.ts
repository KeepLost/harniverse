import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  discoverHookConfigSources,
  readHookConfigSnapshot,
} from '@deepseek-ai/dsh-hook-protocol/src/discovery.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('hook config discovery', () => {
  it('resolves configured layers in deterministic order and deduplicates paths', () => {
    const root = tempDir('dsh-hook-discovery-root-')
    const cwd = tempDir('dsh-hook-discovery-project-')

    expect(discoverHookConfigSources(cwd, {
      root,
      user: ['user.json'],
      project: ['hooks.json', 'shared.json'],
      plugin: ['plugin.json', resolve(cwd, 'shared.json')],
      policy: ['policy.json'],
    })).toEqual([
      { layer: 'user', path: resolve(root, 'user.json') },
      { layer: 'project', path: resolve(cwd, 'hooks.json') },
      { layer: 'project', path: resolve(cwd, 'shared.json') },
      { layer: 'plugin', path: resolve(root, 'plugin.json') },
      { layer: 'policy', path: resolve(root, 'policy.json') },
    ])
  })

  it('uses hooks.json as the safe project default and never uses process.cwd for project discovery', () => {
    const cwd = tempDir('dsh-hook-discovery-project-')

    expect(discoverHookConfigSources(cwd)).toEqual([
      { layer: 'project', path: resolve(cwd, 'hooks.json') },
    ])
    expect(discoverHookConfigSources(undefined, { project: ['hooks.json'] })).toEqual([])
  })

  it('drops empty source names and relative non-project names when no root exists', () => {
    const root = tempDir('dsh-hook-discovery-root-')
    const cwd = tempDir('dsh-hook-discovery-project-')

    expect(discoverHookConfigSources(cwd, {
      root,
      user: [''],
      project: ['hooks.json', ''],
      plugin: ['plugin.json', ''],
      policy: [''],
    })).toEqual([
      { layer: 'project', path: resolve(cwd, 'hooks.json') },
      { layer: 'plugin', path: resolve(root, 'plugin.json') },
    ])

    expect(discoverHookConfigSources(undefined, { plugin: ['plugin.json'] })).toEqual([])
  })

  it('keeps a bad source isolated and freezes the loaded event snapshot', () => {
    const root = tempDir('dsh-hook-discovery-root-')
    const good = join(root, 'good.json')
    const bad = join(root, 'bad.json')
    writeFileSync(good, JSON.stringify({ value: 'good' }))
    writeFileSync(bad, '{')

    const snapshot = readHookConfigSnapshot(
      discoverHookConfigSources(undefined, { root, user: ['good.json', 'bad.json', 'missing.json'], project: [] }),
      raw => raw as { value: string },
    )

    expect(snapshot.loaded).toHaveLength(1)
    expect(snapshot.loaded[0]?.value).toEqual({ value: 'good' })
    expect(snapshot.failures).toHaveLength(1)
    expect(snapshot.failures[0]?.source.path).toBe(bad)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.loaded)).toBe(true)
    expect(Object.isFrozen(snapshot.loaded[0]?.value)).toBe(true)
  })
})
