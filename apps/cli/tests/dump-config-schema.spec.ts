/** The schema dump composes a real profile fixture and exports a valid, known-good JSON Schema document. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import type { ConfigSchemaDump } from '@deepseek-ai/dsh-app-boot'
import { runDumpConfigSchema } from '../src/dump-config-schema.ts'

const profileName = 'schema-acceptance'
const packageName = 'dsh-schema-acceptance-fixture'
const pluginName = `${packageName}/plugin`

// The package root resolves to the last built lib/ until the next build; the
// config-schema half of app-boot is reachable through its source export today
// and through the root re-export once rebuilt. Spreading both keeps this spec
// on the real module either way — no behavior is replaced.
vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  const configSchema = await import('@deepseek-ai/dsh-app-boot/src/config-schema/index.ts')
  return { ...actual, ...configSchema }
})

const modules = new Map<string, unknown>()
const importModule = vi.fn(async (name: string): Promise<unknown> => {
  if (!modules.has(name)) throw new Error(`cannot import ${name}`)
  // Trusted module top-level output must not precede the JSON document on stdout.
  if (name === `${packageName}/noisy`) process.stdout.write(`imported ${name}\n`)
  return modules.get(name)
})

let root: string
let home: string
let stdout: string
let stderr: string
const previousHome = process.env.DSH_HOME
const previousExitCode = process.exitCode

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-schema-dump-'))
  home = join(root, 'home')
  process.env.DSH_HOME = home
  const profileDir = join(home, 'profiles', profileName)
  const moduleDir = join(profileDir, 'node_modules', packageName)
  mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({
    name: packageName, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(moduleDir, 'cordis.patch.yml'), `- insert:\n    - id: schema-ns\n      name: ${pluginName}\n`)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-schema-acceptance', private: true,
    dependencies: { [packageName]: '1.0.0' },
    dsh: { profile: { bundles: [packageName] } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const loader = { import: importModule }
  vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(loader as Pick<ModuleLoader, 'import'> as ModuleLoader)
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  })
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  modules.clear()
  process.exitCode = previousExitCode
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

function entryValidator(dump: ConfigSchemaDump): ReturnType<Ajv2020['compile']> {
  const validator = new Ajv2020({ strict: false, validateFormats: false })
  expect(validator.validateSchema(dump), JSON.stringify(validator.errors)).toBe(true)
  return validator.compile({ $schema: dump.$schema, $defs: dump.$defs, $ref: '#/$defs/entryList' })
}

describe('runDumpConfigSchema', () => {
  it('prints a complete document that accepts the known-good composition and rejects wrong config values', async () => {
    modules.set(pluginName, {
      Config: Schema.object({
        port: Schema.number().default(3080).description('Listening port'),
        attempts: Schema.number().min(1).max(7).default(3),
      }),
    })
    await runDumpConfigSchema(profileName, [])
    expect(process.exitCode).toBe(undefined)
    expect(stdout.startsWith('{\n  "$schema"')).toBe(true)
    const document = JSON.parse(stdout) as ConfigSchemaDump
    expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(document.title).toBe(`Cordis configuration for profile ${profileName}`)
    expect(document['x-cordis'].complete).toBe(true)
    expect(document['x-cordis'].diagnostics).toEqual([])
    expect(document['x-cordis'].entries).toEqual([{
      path: '/0', id: 'schema-ns', name: pluginName, status: 'schema', configRef: '#/$defs/config0',
    }])
    expect(document.$defs.entry).toMatchObject({ type: 'object', required: ['name'] })
    expect(document.$defs.patchList).toMatchObject({ type: 'array' })
    expect(document.$defs.includeConfig).toMatchObject({ type: 'object', required: ['path'] })
    const validate = entryValidator(document)
    expect(validate([{ name: pluginName, config: { port: 8080, attempts: 3 } }])).toBe(true)
    expect(validate([{ name: pluginName, config: { port: 'wrong' } }])).toBe(false)
    expect(validate([{ name: pluginName, config: { __jsExpr: 'ctx.port' } }])).toBe(true)
    const validator = new Ajv2020({ strict: false, validateFormats: false })
    const patch = validator.compile({ $schema: document.$schema, $defs: document.$defs, $ref: '#/$defs/patchList' })
    expect(patch([{ id: 'schema-ns', disabled: true }])).toBe(true)
    expect(patch([{ id: 'schema-ns', config: { port: 'wrong' } }])).toBe(false)
  })

  it('keeps trusted module stdout noise off the JSON document', async () => {
    modules.set(pluginName, { Config: Schema.string() })
    modules.set(`${packageName}/noisy`, { Config: Schema.string() })
    const profileDir = join(home, 'profiles', profileName)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: noisy\n      name: ${packageName}/noisy\n`)
    await runDumpConfigSchema(profileName, [])
    expect(stderr).toBe(`imported ${packageName}/noisy\n`)
    const document = JSON.parse(stdout) as ConfigSchemaDump
    expect(document['x-cordis'].complete).toBe(true)
    // The bundle layer's row stays first; the profile patch's noisy row appends after it.
    expect(document['x-cordis'].entries.map(({ path, id }) => ({ path, id }))).toEqual([
      { path: '/0', id: 'schema-ns' }, { path: '/1', id: 'noisy' },
    ])
    expect(document['x-cordis'].entries[1]).toMatchObject({
      name: `${packageName}/noisy`, status: 'schema',
    })
  })

  it('writes positioned diagnostics to stderr and sets exitCode 1 for an unsupported Config', async () => {
    modules.set(pluginName, { Config: { type: 'object' } })
    await runDumpConfigSchema(profileName, [])
    expect(process.exitCode).toBe(1)
    expect(stderr).toBe('dsh: error: [/0] Config is not a native Schemastery schema\n')
    const document = JSON.parse(stdout) as ConfigSchemaDump
    expect(document['x-cordis'].complete).toBe(false)
    expect(document['x-cordis'].entries[0]).toMatchObject({ path: '/0', status: 'unsupported', configRef: '#/$defs/unknownConfig' })
  })

  it('reports unmatched overlay targets as plain warnings without failing the dump', async () => {
    modules.set(pluginName, { Config: Schema.string() })
    const overlay = join(root, 'unmatched.yml')
    writeFileSync(overlay, '- id: missing\n  disabled: true\n')
    await runDumpConfigSchema(profileName, [overlay])
    expect(process.exitCode).toBe(undefined)
    expect(stderr).toBe('dsh: warning: patch: entry "missing" not found\n')
    const document = JSON.parse(stdout) as ConfigSchemaDump
    expect(document['x-cordis'].complete).toBe(true)
    expect(document['x-cordis'].diagnostics).toEqual([{ level: 'warning', message: 'patch: entry "missing" not found' }])
  })
})
