/** Import and re-export forms accepted or rejected by the optional-dependency load check. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TypeScriptProject } from './ts-project.ts'
import { collectOptionalImportViolations } from './verify-optional-dependency-imports.ts'

const FIXTURE: Record<string, string> = {
  'tsconfig.host.json': JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      noEmit: true,
      skipLibCheck: true,
      types: [],
      paths: {
        '@f/opt': ['./packages/f/opt/src/index.ts'],
        '@f/hard': ['./packages/f/hard/src/index.ts'],
      },
    },
    include: ['packages/**/*.ts'],
  }),
  'packages/f/opt/package.json': JSON.stringify({ name: '@f/opt', version: '0.0.1' }),
  'packages/f/opt/src/index.ts': [
    'export interface Shape { a: number }',
    'export const runtimeValue = 1',
    '',
  ].join('\n'),
  'packages/f/hard/package.json': JSON.stringify({ name: '@f/hard', version: '0.0.1' }),
  'packages/f/hard/src/index.ts': 'export const hardValue = 2\n',
  'packages/f/consumer/package.json': JSON.stringify({
    name: '@f/consumer',
    version: '0.0.1',
    dependencies: { '@f/hard': '*' },
    peerDependencies: { '@f/opt': '*' },
    peerDependenciesMeta: { '@f/opt': { optional: true } },
  }),
  'packages/f/consumer/src/allowed-type-only.ts': [
    "import type {} from '@f/opt'",
    'export const a = 1',
    '',
  ].join('\n'),
  'packages/f/consumer/src/allowed-empty.ts': [
    "import {} from '@f/opt'",
    'export const b = 1',
    '',
  ].join('\n'),
  'packages/f/consumer/src/allowed-inline-type.ts': [
    "import { type Shape } from '@f/opt'",
    'export const c: Shape = { a: 1 }',
    '',
  ].join('\n'),
  'packages/f/consumer/src/allowed-type-binding.ts': [
    "import { Shape } from '@f/opt'",
    'export const d: Shape = { a: 1 }',
    '',
  ].join('\n'),
  'packages/f/consumer/src/allowed-type-reexport.ts': [
    "export type { Shape } from '@f/opt'",
    '',
  ].join('\n'),
  'packages/f/consumer/src/allowed-hard-dependency.ts': [
    "import { hardValue } from '@f/hard'",
    'export const e = hardValue',
    '',
  ].join('\n'),
  'packages/f/consumer/src/rejected-bare.ts': [
    "import '@f/opt'",
    'export const f = 1',
    '',
  ].join('\n'),
  'packages/f/consumer/src/rejected-value.ts': [
    "import { runtimeValue } from '@f/opt'",
    'export const g = runtimeValue',
    '',
  ].join('\n'),
  'packages/f/consumer/src/rejected-star-reexport.ts': [
    "export * from '@f/opt'",
    '',
  ].join('\n'),
}

const root = mkdtempSync(join(tmpdir(), 'optional-imports-'))
for (const [relativePath, content] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true })
  writeFileSync(join(root, relativePath), content)
}
const violations = collectOptionalImportViolations(new TypeScriptProject(root))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('optional dependency loads', () => {
  it('reports every import form that survives emit and nothing else', () => {
    expect(violations.map(violation => violation.split(' loads ')[0])).toEqual([
      'packages/f/consumer/src/rejected-bare.ts:1',
      'packages/f/consumer/src/rejected-star-reexport.ts:1',
      'packages/f/consumer/src/rejected-value.ts:1',
    ])
  })

  it('names the declaration that made the package optional and the safe remedies', () => {
    expect(violations[0]).toBe(
      'packages/f/consumer/src/rejected-bare.ts:1 loads @f/opt at module scope,'
      + ' declared optional in peerDependenciesMeta; import it as a type,'
      + ' or restructure so module scope does not need it',
    )
  })
})
