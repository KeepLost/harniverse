/**
 * Reject a static value import of an optional dependency.
 *
 * Dependencies declared in `optionalDependencies`, or as peers carrying
 * `peerDependenciesMeta.<name>.optional`, may be absent from an installed tree.
 * A module-scope value import would turn that supported absence into a load
 * failure before the owning capability can report itself unavailable.
 *
 * A bound Program decides value-versus-type because `verbatimModuleSyntax` is
 * off: imports whose bindings resolve only to types are erased. Both compiler
 * faces are scanned, and only package source that ships is subject.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { TypeScriptProject, type CompilerFace } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')
const PUBLISHED_SOURCE = /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+)\/src\//

type OptionalKind = 'optionalDependencies' | 'peerDependenciesMeta'

/** Return the package portion of a bare package or package subpath specifier. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier
}

/** Read one manifest field as a record, or return an empty record. */
function record(manifest: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = manifest[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Collect each dependency one manifest permits an installed tree to omit. */
function optionalDependencies(manifest: Record<string, unknown>): Map<string, OptionalKind> {
  const optional = new Map<string, OptionalKind>()
  for (const name of Object.keys(record(manifest, 'optionalDependencies'))) {
    optional.set(name, 'optionalDependencies')
  }
  const peers = record(manifest, 'peerDependencies')
  for (const [name, meta] of Object.entries(record(manifest, 'peerDependenciesMeta'))) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) continue
    if ((meta as Record<string, unknown>).optional !== true || !(name in peers)) continue
    optional.set(name, 'peerDependenciesMeta')
  }
  return optional
}

const optionalByDirectory = new Map<string, Map<string, OptionalKind>>()

/** Resolve the optional dependencies declared by the package owning one source file. */
function optionalFor(projectRoot: string, relativePath: string): Map<string, OptionalKind> {
  const directory = resolve(projectRoot, relativePath.slice(0, relativePath.indexOf('/src/')))
  const cached = optionalByDirectory.get(directory)
  if (cached !== undefined) return cached
  const manifestPath = resolve(directory, 'package.json')
  const parsed: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
  const manifest = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  const optional = optionalDependencies(manifest)
  optionalByDirectory.set(directory, optional)
  return optional
}

/** Return whether an import or re-export binding resolves to a runtime value. */
function bindsValue(name: ts.Identifier | ts.StringLiteral, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(name)
  if (symbol === undefined) return true
  const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
  return (target.flags & ts.SymbolFlags.Value) !== 0
}

/** Return whether an import declaration survives emit and loads its module. */
function importLoadsModule(declaration: ts.ImportDeclaration, checker: ts.TypeChecker): boolean {
  const clause = declaration.importClause
  if (clause === undefined) return true
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false
  if (clause.name !== undefined) return true
  const bindings = clause.namedBindings
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some(element => !element.isTypeOnly && bindsValue(element.name, checker))
}

/** Return whether a re-export declaration survives emit and loads its module. */
function exportLoadsModule(declaration: ts.ExportDeclaration, checker: ts.TypeChecker): boolean {
  if (declaration.isTypeOnly) return false
  const clause = declaration.exportClause
  if (clause === undefined || ts.isNamespaceExport(clause)) return true
  return clause.elements.some(element => !element.isTypeOnly && bindsValue(element.name, checker))
}

/**
 * Collect static runtime loads of optional dependencies in one compiler face.
 * @param project - bound repository project.
 * @returns violation messages sorted by source location.
 */
export function collectOptionalImportViolations(project: TypeScriptProject): string[] {
  const checker = project.checker
  const violations: string[] = []
  for (const sourceFile of project.sourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    const relativePath = project.relativePath(sourceFile)
    if (!PUBLISHED_SOURCE.test(relativePath)) continue
    const optional = optionalFor(project.projectRoot, relativePath)
    if (optional.size === 0) continue

    for (const statement of sourceFile.statements) {
      const isImport = ts.isImportDeclaration(statement)
      if (!isImport && !ts.isExportDeclaration(statement)) continue
      const specifierNode = statement.moduleSpecifier
      if (specifierNode === undefined || !ts.isStringLiteral(specifierNode)) continue
      const kind = optional.get(packageOf(specifierNode.text))
      if (kind === undefined) continue
      const loads = isImport
        ? importLoadsModule(statement, checker)
        : exportLoadsModule(statement, checker)
      if (!loads) continue
      const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
      violations.push(
        `${relativePath}:${String(line + 1)} loads ${specifierNode.text} at module scope,`
        + ` declared optional in ${kind}; import it as a type, or restructure so module scope does not need it`,
      )
    }
  }
  return violations.sort((left, right) => left.localeCompare(right))
}

function main(): void {
  const faces: readonly CompilerFace[] = ['host', 'client']
  const violations = new Set<string>()
  for (const face of faces) {
    for (const violation of collectOptionalImportViolations(new TypeScriptProject(root, face))) {
      violations.add(violation)
    }
  }
  if (violations.size === 0) {
    console.log('verify-optional-dependency-imports: no optional dependency is loaded at module scope.')
    return
  }
  console.error(`verify-optional-dependency-imports: ${String(violations.size)} optional dependency load(s) at module scope:`)
  for (const violation of [...violations].sort((left, right) => left.localeCompare(right))) {
    console.error(`  ${violation}`)
  }
  process.exit(1)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main()
