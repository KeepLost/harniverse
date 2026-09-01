/** Regression coverage for source declarations owned by the client test aggregate. */

import { existsSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function clientCssDeclarations(): string[] {
  const clientGroups = ['client', 'extensions']
  return clientGroups.flatMap((group) => {
    const clientRoot = resolve(root, 'packages', group)
    return readdirSync(clientRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(clientRoot, entry.name, 'src/css-modules.d.ts'))
  })
    .filter(existsSync)
    .map(file => file.replaceAll(sep, '/'))
    .sort()
}

function clientConfig(): ts.ParsedCommandLine {
  const configPath = resolve(root, 'tsconfig.client.json')
  const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, root)
}

describe('client TypeScript aggregate', () => {
  it('loads package CSS declarations without relying on workspace-link realpaths', () => {
    const parsed = clientConfig()
    const loaded = parsed.fileNames
      .map(file => file.replaceAll(sep, '/'))
      .filter(file => file.endsWith('/src/css-modules.d.ts'))
      .sort()
    expect(loaded).toEqual(clientCssDeclarations())
  })

  it('resolves public package subpaths from source instead of generated artifacts', () => {
    const parsed = clientConfig()
    const importer = resolve(root, 'packages/client/ui-reference/src/client/index.ts')
    for (const [specifier, source] of [
      ['@deepseek-ai/dsh-file-reference/types', 'packages/context/file-reference/src/types.ts'],
      ['@deepseek-ai/dsh-session-reference/types', 'packages/context/session-reference/src/types.ts'],
      ['@deepseek-ai/dsh-tool-fs/read-render', 'packages/fs/tool-fs/src/read-render.ts'],
    ] as const) {
      const resolved = ts.resolveModuleName(specifier, importer, parsed.options, ts.sys).resolvedModule
      expect(resolved?.resolvedFileName.replaceAll(sep, '/')).toBe(resolve(root, source).replaceAll(sep, '/'))
      expect(resolved?.isExternalLibraryImport).toBe(false)
    }
  })
})
