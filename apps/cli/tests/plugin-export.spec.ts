/**
 * `dsh plugin export` and `export-manifest`: argument parsing, profile and
 * dependency guards, provenance reporting, pack execution (real pnpm for the
 * success path), and the replay manifest's stdout and file forms.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runPlugin, runPluginExport, runPluginExportManifest } from '../src/plugin.ts'

const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-export-cli-'))
const profileDir = join(home, 'profiles', 'demo')
const outDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-export-out-'))
const sourceDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-export-src-'))

beforeEach(() => {
  process.env.DSH_HOME = home
})

afterEach(() => {
  delete process.env.DSH_HOME
})

/** Write a profile manifest with the given dependency specs. */
function writeProfile(dependencies: Record<string, string>): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-demo',
    private: true,
    dependencies,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plug'] } },
  }))
}

/** A minimal packable plugin package on disk. */
function writePlugin(dir: string, name: string, version: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module' }))
  writeFileSync(join(dir, 'index.js'), 'export const name = "x"\n')
}

describe('runPluginExport', () => {
  it('packs a linked source plugin with real pnpm and prints its tarball path', () => {
    writePlugin(sourceDir, 'plug', '0.2.0')
    writeProfile({ plug: `link:${sourceDir}` })
    const code = runPluginExport('demo', ['plug', '--out', outDir], outDir)
    expect(code).toBe(0)
    const tarball = join(outDir, 'plug-0.2.0.tgz')
    expect(tarballExists(tarball)).toBe(true)
  }, 30_000)

  it('rejects an uninitialized profile without creating one', () => {
    const code = runPluginExport('missing', ['plug'])
    expect(code).toBe(1)
  })

  it('lists the installed dependencies when the name is unknown', () => {
    writePlugin(sourceDir, 'plug', '0.2.0')
    writeProfile({ plug: `link:${sourceDir}` })
    const code = runPluginExport('demo', ['other'])
    expect(code).toBe(1)
  })

  it('rejects malformed invocations', () => {
    writeProfile({})
    expect(runPluginExport('demo', [])).toBe(1)
    expect(runPluginExport('demo', ['--out'])).toBe(1)
    expect(runPluginExport('demo', ['plug', '--wat'])).toBe(1)
    expect(runPluginExport('demo', ['plug', 'extra'])).toBe(1)
  })

  it('anchors a relative --out to the invoking directory', () => {
    writePlugin(sourceDir, 'plug', '0.2.0')
    writeProfile({ plug: `link:${sourceDir}` })
    const code = runPluginExport('demo', ['plug', '--out', '.'], outDir)
    expect(code).toBe(0)
    expect(tarballExists(join(outDir, 'plug-0.2.0.tgz'))).toBe(true)
  }, 30_000)

  it('rejects an --out directory that does not exist', () => {
    writePlugin(sourceDir, 'plug', '0.2.0')
    writeProfile({ plug: `link:${sourceDir}` })
    expect(runPluginExport('demo', ['plug', '--out', join(outDir, 'nope')])).toBe(1)
  })

  it('reports a remote dependency whose installed copy is gone', () => {
    writeProfile({ plug: '^1.0.0' })
    expect(runPluginExport('demo', ['plug'])).toBe(1)
  })
})

describe('runPluginExportManifest', () => {
  it('prints the replay manifest as JSON on stdout', () => {
    writeProfile({ plug: `link:${sourceDir}` })
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }
    try {
      const code = runPluginExportManifest('demo', [])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = original
    }
    const payload = JSON.parse(writes.join('')) as { profile: string; bundles: string[]; dependencies: Record<string, string> }
    expect(payload).toEqual({
      profile: 'demo',
      bundles: ['@deepseek-ai/dsh-base', 'plug'],
      dependencies: { plug: `link:${sourceDir}` },
    })
  })

  it('writes the manifest to --out anchored to the invoking directory', () => {
    writeProfile({ plug: `link:${sourceDir}` })
    const file = 'manifest.json'
    const code = runPluginExportManifest('demo', ['--out', file], outDir)
    expect(code).toBe(0)
    const payload = JSON.parse(readFileSync(join(outDir, file), 'utf8')) as { profile: string }
    expect(payload.profile).toBe('demo')
  })

  it('rejects bad arguments and uninitialized profiles', () => {
    expect(runPluginExportManifest('demo', ['--out'])).toBe(1)
    expect(runPluginExportManifest('demo', ['extra'])).toBe(1)
    expect(runPluginExportManifest('missing', [])).toBe(1)
  })
})

describe('runPlugin dispatch', () => {
  it('routes export to the packer instead of pnpm', () => {
    writePlugin(sourceDir, 'plug', '0.2.0')
    writeProfile({ plug: `link:${sourceDir}` })
    expect(runPlugin('demo', ['export', 'plug', '--out', outDir])).toBe(0)
    expect(tarballExists(join(outDir, 'plug-0.2.0.tgz'))).toBe(true)
  }, 30_000)
})

/** Whether a tarball file exists at `path`. */
function tarballExists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}
