/**
 * Plugin export core: spec classification, pack-source resolution (source
 * checkout vs installed copy), and the `pnpm pack` runner's success and
 * failure paths.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyDependencySpec,
  packPluginTarball,
  resolvePluginExportSource,
  type PluginPackSpawn,
} from '../src/plugin-export.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-plugin-export-'))

/** A minimal profile fixture: manifest plus optionally an installed copy. */
function profileWith(options: { dependencies?: Record<string, string>; installed?: string[] } = {}): string {
  const dir = tmp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture',
    private: true,
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  }))
  for (const name of options.installed ?? []) {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  return dir
}

describe('classifyDependencySpec', () => {
  it('classifies link, file, and bare path specs as filesystem specs', () => {
    expect(classifyDependencySpec('link:../plugin')).toBe('path')
    expect(classifyDependencySpec('link:/abs/plugin')).toBe('path')
    expect(classifyDependencySpec('file:/abs/plugin')).toBe('path')
    expect(classifyDependencySpec('/abs/plugin')).toBe('path')
    expect(classifyDependencySpec('./plugin')).toBe('path')
    expect(classifyDependencySpec('../plugin')).toBe('path')
    expect(classifyDependencySpec('C:\\dev\\plugin')).toBe('path')
  })

  it('classifies registry, git, and tarball specs as remote', () => {
    expect(classifyDependencySpec('^1.2.3')).toBe('remote')
    expect(classifyDependencySpec('latest')).toBe('remote')
    expect(classifyDependencySpec('npm:other@2.0.0')).toBe('remote')
    expect(classifyDependencySpec('github:user/repo#v1')).toBe('remote')
    expect(classifyDependencySpec('git+https://example.invalid/x.git')).toBe('remote')
    expect(classifyDependencySpec('https://example.invalid/x-1.0.0.tgz')).toBe('remote')
  })
})

describe('resolvePluginExportSource', () => {
  it('packs a live link/file source directory over the installed copy', () => {
    const source = tmp()
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'plug', version: '0.1.0' }))
    const profile = profileWith({ dependencies: { plug: `link:${source}` }, installed: ['plug'] })
    expect(resolvePluginExportSource('dsh', 'plug', `link:${source}`, profile)).toEqual({ provenance: 'source', dir: source })
  })

  it('resolves a relative path spec against the profile directory', () => {
    const profile = profileWith({ dependencies: { plug: 'file:../plug' } })
    const source = join(profile, '..', 'plug')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'plug', version: '0.1.0' }))
    expect(resolvePluginExportSource('dsh', 'plug', 'file:../plug', profile))
      .toEqual({ provenance: 'source', dir: source })
  })

  it('falls back to the installed copy when the source directory vanished', () => {
    const profile = profileWith({ dependencies: { plug: 'link:/definitely/not/here' }, installed: ['plug'] })
    expect(resolvePluginExportSource('dsh', 'plug', 'link:/definitely/not/here', profile))
      .toEqual({ provenance: 'installed', dir: join(profile, 'node_modules', 'plug') })
  })

  it('packs remote specs from the installed copy', () => {
    const profile = profileWith({ dependencies: { plug: '^1.0.0' }, installed: ['plug'] })
    expect(resolvePluginExportSource('dsh', 'plug', '^1.0.0', profile))
      .toEqual({ provenance: 'installed', dir: join(profile, 'node_modules', 'plug') })
  })

  it('returns undefined for a remote spec with no installed copy', () => {
    const profile = profileWith({ dependencies: { plug: '^1.0.0' } })
    expect(resolvePluginExportSource('dsh', 'plug', '^1.0.0', profile)).toBeUndefined()
  })

  it('throws when a path spec resolves to neither source nor installed copy', () => {
    const profile = profileWith({ dependencies: { plug: 'link:/definitely/not/here' } })
    expect(() => resolvePluginExportSource('dsh', 'plug', 'link:/definitely/not/here', profile))
      .toThrow('cannot export "plug"')
  })
})

/** A fake spawner returning recorded calls plus a scripted result. */
function fakeSpawn(result: { status?: number | null; stdout?: string; stderr?: string; error?: Error }): {
  spawn: PluginPackSpawn
  calls: { command: string; args: readonly string[]; cwd: string | URL | undefined }[]
} {
  const calls: { command: string; args: readonly string[]; cwd: string | URL | undefined }[] = []
  const spawn: PluginPackSpawn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd })
    return {
      status: result.status === undefined ? 0 : result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }
  return { spawn, calls }
}

describe('packPluginTarball', () => {
  it('packs with pnpm into the destination and parses the printed tarball path', () => {
    const packageDir = tmp()
    const destination = tmp()
    const tarball = join(destination, 'plug-0.1.0.tgz')
    const { spawn, calls } = fakeSpawn({ stdout: `Tarball Details\n${tarball}\n` })
    writeFileSync(tarball, 'fixture')
    expect(packPluginTarball('dsh', packageDir, destination, spawn)).toEqual({ ok: true, tarballPath: tarball })
    expect(calls).toEqual([{ command: 'pnpm', args: ['pack', '--pack-destination', destination], cwd: packageDir }])
  })

  it('resolves a lone destination tarball when the printed path shape changes', () => {
    const packageDir = tmp()
    const destination = tmp()
    const tarball = join(destination, 'plug-0.1.0.tgz')
    const { spawn } = fakeSpawn({ stdout: 'done, somehow' })
    writeFileSync(tarball, 'fixture')
    expect(packPluginTarball('dsh', packageDir, destination, spawn)).toEqual({ ok: true, tarballPath: tarball })
  })

  it('reports a pack failure with the exit code and diagnostic tail', () => {
    const { spawn } = fakeSpawn({ status: 1, stderr: 'ERR_PNPM  broken manifest\n' })
    expect(packPluginTarball('dsh', tmp(), tmp(), spawn)).toEqual({
      ok: false,
      reason: 'pack-failed',
      exitCode: 1,
      stderrTail: 'ERR_PNPM  broken manifest',
    })
  })

  it('reports pnpm missing with exit code 127', () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
    expect(packPluginTarball('dsh', tmp(), tmp(), spawn)).toEqual({
      ok: false,
      reason: 'pnpm-missing',
      exitCode: 127,
      stderrTail: 'dsh: pnpm not found on PATH — install pnpm to pack plugin tarballs',
    })
  })

  it('reports a spawn failure pnpm-side signals as a pack failure', () => {
    const { spawn } = fakeSpawn({ status: null, error: new Error('spawn EACCES') })
    expect(packPluginTarball('dsh', tmp(), tmp(), spawn)).toEqual({
      ok: false,
      reason: 'pack-failed',
      exitCode: 1,
      stderrTail: '',
    })
  })

  it('fails when success printed no usable tarball into an ambiguous destination', () => {
    const destination = tmp()
    const { spawn } = fakeSpawn({ stdout: '' })
    expect(packPluginTarball('dsh', tmp(), destination, spawn)).toEqual({
      ok: false,
      reason: 'pack-failed',
      exitCode: 0,
      stderrTail: `dsh: pnpm pack reported success but named no tarball in ${destination}`,
    })
  })
})
