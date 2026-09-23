/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts`) may import
 * across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/            domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts   assembly point and re-export shell
 *
 * Top-level files other than the assembly point sit beside the domains rather
 * than above them: they are the package's own shared material, so every domain
 * may read them and they may not reach into a domain.
 *
 * The regime applies only to a package that actually has sibling domains. A
 * package whose `src/client/` holds at most one non-contract directory has no
 * sibling edge to draw, and its single directory is an ordinary component
 * folder rather than a domain — `packages/client/AGENTS.md` scopes the split to
 * packages "where its code could later become separate packages".
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-domain-graph.ts
 */

import { globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CLIENT_DIR = join(root, 'packages/client')

/** Directory names treated as the shared contract layer (importable by all). */
const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx'])

/**
 * Every way a module specifier reaches this file's source. `import(...)` is
 * listed because an inline `import('../x.ts').Type` expression is a real edge
 * that no `from` clause reports.
 */
const SPECIFIER_PATTERNS = [
  /from\s+['"](\.[^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"](\.[^'"]+)['"]/gu,
]

interface Violation { file: string; line: number; imported: string; reason: string }

/** Recursively list .ts/.tsx files under dir (relative paths). */
function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => !/\.legacy\./.test(rel.slice(rel.lastIndexOf('/') + 1)))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

/**
 * Resolve a relative specifier to a client-dir-relative path.
 * @param fromRel - importing file, relative to the client dir.
 * @param spec - the relative specifier as written.
 * @returns the target path, or undefined when it climbs above the client dir
 *   (a package-root sibling such as `src/core/`, which package-level rules
 *   govern).
 */
function resolveSpecifier(fromRel: string, spec: string): string | undefined {
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : ''
  const parts = fromDir === '' ? [] : fromDir.split('/')
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') {
      parts.push(seg)
      continue
    }
    // Popping an empty stack means the specifier left `src/client/` entirely.
    if (parts.length === 0) return undefined
    parts.pop()
  }
  return parts.join('/')
}

/** Directories under a client dir that carry the sibling-domain regime. */
function domainsOf(files: string[]): Set<string> {
  const domains = new Set<string>()
  for (const rel of files) {
    const domain = domainOf(rel)
    if (domain !== '' && !CONTRACT_DIRS.has(domain)) domains.add(domain)
  }
  return domains
}

/** 1-based line of a source offset. */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1
  return line
}

function checkPackage(pkgName: string, clientDir: string): Violation[] {
  const violations: Violation[] = []
  const files = listSources(clientDir)
  // One domain has no sibling to cross, so the directory is a component folder
  // and the regime has nothing to say about it.
  if (domainsOf(files).size < 2) return violations
  for (const rel of files) {
    const fromDomain = domainOf(rel)
    const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(rel)
    if (isAssembly) continue
    const source = readFileSync(join(clientDir, rel), 'utf8')
    const seen = new Set<string>()
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1]
        if (spec === undefined) continue
        // One specifier can satisfy two patterns; report the statement once.
        const at = `${String(match.index)}:${spec}`
        if (seen.has(at)) continue
        seen.add(at)
        const target = resolveSpecifier(rel, spec)
        if (target === undefined) continue
        const toDomain = domainOf(target)
        if (toDomain === '' || CONTRACT_DIRS.has(toDomain)) continue // top-level shared file or contract layer
        if (fromDomain === toDomain) continue // inside one domain
        violations.push({
          file: `${pkgName}/src/client/${rel}`,
          line: lineAt(source, match.index),
          imported: spec,
          reason: fromDomain === ''
            ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
            : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
        })
      }
    }
  }
  return violations
}

const violations: Violation[] = []
for (const pkg of readdirSync(CLIENT_DIR)) {
  const clientDir = join(CLIENT_DIR, pkg, 'src/client')
  try {
    if (!statSync(clientDir).isDirectory()) continue
  } catch {
    // No client half in this package — nothing to layer-check.
    continue
  }
  violations.push(...checkPackage(pkg, clientDir))
}

if (violations.length > 0) {
  console.error(`verify-client-domain-graph: ${String(violations.length)} violation(s):`)
  for (const v of violations) {
    console.error(`  ${v.file}:${String(v.line)} -> ${v.imported}\n    ${v.reason}`)
  }
  process.exit(1)
}
console.log('verify-client-domain-graph: client domain layering clean.')
