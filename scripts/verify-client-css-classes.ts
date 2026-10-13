/**
 * Reject client CSS Module usage that the plugin bundler turns into silent
 * no-ops.
 *
 * A client plugin reads its class names from `import css from './X.module.css'`.
 * The bundler (`packages/client/tsdown.client.ts`, the `dsh-css-modules-inline`
 * plugin) exports one flat `{ local: hashedLocal }` map per stylesheet, so
 * nothing about a class is checked at build or run time:
 *
 *   - `css.missing` is `undefined`; `clsx` drops it and the element renders
 *     unstyled. The `.d.ts` shim types every key as `string`, so tsc is silent.
 *   - `composes:` is parsed by lightningcss, but the bundler copies only each
 *     export's own `name` into the map. The composed classes never reach the
 *     element, so the declaring class loses everything it composed.
 *   - A class whose only rules are pseudo-state selectors (`.x:hover`) styles
 *     nothing at rest. Used without the class it modifies, it renders bare.
 *
 * Vitest cannot catch the first case either: it proxies CSS Module lookups, so
 * an undeclared class still resolves to a hashed name in component specs.
 *
 * Findings:
 *   - `undefined-class`: a `css.x` / `css['x']` reference whose class the imported
 *     module never declares (a `@keyframes` name counts as declared; CSS
 *     Modules export those too).
 *   - `missing-stylesheet`: the imported `.module.css` does not exist.
 *   - `composes`: any `composes:` declaration in a client `.module.css`.
 *   - `state-only`: a native element (`<button>`, `<div>`, ...) whose
 *     `className` is built from nothing but module classes, none of which any
 *     selector styles at rest: every rule for each is qualified by a
 *     pseudo-state class (`:hover`, `:focus-visible`, `:disabled`, ...). A
 *     negated state (`.x:not(:disabled)`) styles the resting state and does
 *     not count. A state-only class beside its base class (`iconButton` +
 *     `iconButtonDanger`) or on a component that supplies the base (`<Button
 *     className={css.reject}>`) is an ordinary modifier and is accepted.
 *
 * Dynamic lookups (`css[variant]`, `css[\`chip_${state}\`]`) and a stylesheet
 * binding passed around whole are not resolved: only literal keys are checked.
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-css-classes.ts
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/** Source trees whose CSS Modules and importers are governed. */
const SCAN_GLOBS = ['packages/client/*/src', 'apps/web/src']

/** Conditional group at-rules: their body holds ordinary style rules. */
const GROUP_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style', 'document'])

/** Pseudo-classes that qualify a rule to a transient state of the element. */
const STATE_PSEUDO_CLASSES = [
  'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'disabled', 'enabled', 'checked', 'visited',
  'indeterminate', 'invalid', 'valid', 'read-only', 'placeholder-shown', 'open',
]
const STATE_PSEUDO = new RegExp(`:(?:${STATE_PSEUDO_CLASSES.join('|')})(?![\\w-])`, 'u')

const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/gu

/** What a stylesheet declares about one local class. */
interface ClassDeclaration {
  /** True when some selector names the class without a pseudo-state qualifier. */
  standalone: boolean
}

/** One `composes:` declaration. */
interface ComposesDeclaration { line: number; text: string }

/** The names a CSS Module exports, as far as references can be checked. */
export interface CssModuleInfo {
  /** Local class names the selectors mention outside `:global(...)`. */
  classes: Map<string, ClassDeclaration>
  /** `@keyframes` names; CSS Modules hash and export these like classes. */
  keyframes: Set<string>
  composes: ComposesDeclaration[]
}

/** One literal `css.x` / `css['x']` lookup in TS source. */
interface ClassReference {
  file: string
  line: number
  /** Local binding of the default import, as written. */
  binding: string
  /** Class name looked up. */
  name: string
  /** Import specifier as written. */
  specifier: string
  /** Repository-relative path the specifier resolves to. */
  stylesheet: string
  /**
   * Set when the lookup is part of a native element's `className` made of
   * module classes alone; lookups sharing a group are applied together.
   */
  group?: number
}

type ViolationKind = 'undefined-class' | 'missing-stylesheet' | 'composes' | 'state-only'

/** One finding; `subject` is the class name, the composes text, or the missing path. */
interface Violation { file: string; line: number; kind: ViolationKind; subject: string; stylesheet: string }

/** Blank comments and strings while keeping newlines, so offsets and lines survive. */
function withoutCssNoise(text: string): string {
  const blank = (match: string): string => match.replaceAll(/[^\n]/gu, ' ')
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, blank)
    .replaceAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gu, blank)
}

/** Drop `:global(...)` scopes: classes inside them are not module-local. */
function withoutGlobalScopes(selector: string): string {
  const marker = ':global('
  let out = ''
  let index = 0
  while (index < selector.length) {
    if (!selector.startsWith(marker, index)) {
      out += selector.charAt(index)
      index += 1
      continue
    }
    let depth = 1
    index += marker.length
    while (index < selector.length && depth > 0) {
      if (selector[index] === '(') depth += 1
      else if (selector[index] === ')') depth -= 1
      index += 1
    }
  }
  return out
}

/**
 * Local classes in one selector list.
 * @param prelude - text before a rule's `{`, comments and strings already blanked.
 * @returns every module-local class occurrence; `standalone` is false when the
 *   occurrence sits in a compound qualified by a pseudo-state class, and always
 *   true inside a functional pseudo (`:not(.x)`, `:is(.x)`), which does not
 *   style the class by itself either way.
 */
function selectorClasses(prelude: string): { name: string; standalone: boolean }[] {
  const found: { name: string; standalone: boolean }[] = []
  let depth = 0
  let top = ''
  let nested = ''
  const endCompound = (): void => {
    const stateful = STATE_PSEUDO.test(top)
    for (const [, name = ''] of top.matchAll(CLASS_TOKEN)) found.push({ name, standalone: !stateful })
    for (const [, name = ''] of nested.matchAll(CLASS_TOKEN)) found.push({ name, standalone: true })
    top = ''
    nested = ''
  }
  for (const char of withoutGlobalScopes(prelude)) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth > 0) nested += char
    else if (/[\s,>+~]/u.test(char)) endCompound()
    else top += char
  }
  endCompound()
  return found
}

/**
 * Parse the class surface of one CSS Module.
 * @param text - stylesheet source.
 * @returns declared classes, keyframe names, and `composes:` declarations.
 */
export function parseCssModule(text: string): CssModuleInfo {
  const source = withoutCssNoise(text)
  const classes = new Map<string, ClassDeclaration>()
  const keyframes = new Set<string>()
  const composes: ComposesDeclaration[] = []
  // 'rule' bodies may nest rules, 'group' at-rules hold rules, and 'opaque'
  // bodies (keyframes, font-face, ...) hold no selectors.
  const stack: ('rule' | 'group' | 'opaque')[] = []
  let start = 0

  const noteStatement = (end: number): void => {
    const statement = source.slice(start, end)
    if (!/^\s*composes\s*:/u.test(statement)) return
    const first = start + statement.length - statement.trimStart().length
    composes.push({
      line: source.slice(0, first).split('\n').length,
      // Original text: blanking replaced the `from '...'` string.
      text: text.slice(first, end).trim().replaceAll(/\s+/gu, ' '),
    })
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (char === '{') {
      const prelude = source.slice(start, index).trim()
      if (stack.at(-1) === 'opaque') {
        stack.push('opaque')
      } else if (prelude.startsWith('@')) {
        const name = /^@(?:-[a-z]+-)?([\w-]+)/u.exec(prelude)?.[1] ?? ''
        if (name === 'keyframes') keyframes.add(prelude.replace(/^@\S+\s*/u, '').trim())
        stack.push(GROUP_AT_RULES.has(name) ? 'group' : 'opaque')
      } else {
        for (const { name, standalone } of selectorClasses(prelude)) {
          classes.set(name, { standalone: standalone || classes.get(name)?.standalone === true })
        }
        stack.push('rule')
      }
      start = index + 1
    } else if (char === ';') {
      noteStatement(index)
      start = index + 1
    } else if (char === '}') {
      noteStatement(index)
      stack.pop()
      start = index + 1
    }
  }
  return { classes, keyframes, composes }
}

/**
 * Findings that need only the stylesheet itself.
 * @param file - repository-relative stylesheet path.
 * @param info - parsed module.
 * @returns one `composes` finding per declaration.
 */
export function findComposesViolations(file: string, info: CssModuleInfo): Violation[] {
  return info.composes.map(({ line, text }) => ({ file, line, kind: 'composes', subject: text, stylesheet: file }))
}

/**
 * Literal CSS Module lookups in one TS/TSX source.
 * @param file - repository-relative importer path; relative specifiers resolve against it.
 * @param text - source text.
 * @returns one reference per literal `binding.name` or `binding['name']`.
 */
export function collectClassReferences(file: string, text: string): ClassReference[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const bindings = new Map<string, { specifier: string; stylesheet: string }>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const binding = statement.importClause?.name
    if (binding === undefined || !specifier.endsWith('.module.css')) continue
    bindings.set(binding.text, { specifier, stylesheet: posix.normalize(posix.join(posix.dirname(file), specifier)) })
  }

  /** The literal lookup a node spells, when it is one. */
  const lookupOf = (node: ts.Node): { binding: string; name: string; at: ts.Node } | undefined => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      return { binding: node.expression.text, name: node.name.text, at: node.name }
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const key = node.argumentExpression
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        return { binding: node.expression.text, name: key.text, at: key }
      }
    }
    return undefined
  }

  /**
   * The lookups an expression consists of, when it consists of nothing else:
   * a bare lookup, a template of lookups separated by spaces, or `clsx` over
   * such parts. Any other class source (literal text, props, conditions)
   * returns undefined.
   */
  const lookupsOnly = (expression: ts.Expression): ts.Node[] | undefined => {
    if (ts.isParenthesizedExpression(expression)) return lookupsOnly(expression.expression)
    const lookup = lookupOf(expression)
    if (lookup !== undefined) return bindings.has(lookup.binding) ? [expression] : undefined
    let parts: ts.Expression[] = []
    if (ts.isTemplateExpression(expression)) {
      const texts = [expression.head, ...expression.templateSpans.map(span => span.literal)]
      if (texts.some(piece => piece.text.trim() !== '')) return undefined
      parts = expression.templateSpans.map(span => span.expression)
    } else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'clsx') {
      parts = [...expression.arguments]
    } else {
      return undefined
    }
    const found: ts.Node[] = []
    for (const part of parts) {
      const inner = lookupsOnly(part)
      if (inner === undefined) return undefined
      found.push(...inner)
    }
    return found
  }

  const references: ClassReference[] = []
  const groupOf = new Map<ts.Node, number>()
  let groups = 0
  const visit = (node: ts.Node): void => {
    // A native element has no base class of its own, so a className of module
    // classes alone is everything it renders with.
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'className'
      && node.initializer !== undefined && ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
      const element = node.parent.parent
      if (/^[a-z]/u.test(element.tagName.getText(sourceFile))) {
        const parts = lookupsOnly(node.initializer.expression)
        if (parts !== undefined) {
          for (const part of parts) groupOf.set(part, groups)
          groups += 1
        }
      }
    }
    const lookup = lookupOf(node)
    const target = lookup === undefined ? undefined : bindings.get(lookup.binding)
    if (lookup !== undefined && target !== undefined) {
      const line = sourceFile.getLineAndCharacterOfPosition(lookup.at.getStart(sourceFile)).line + 1
      const group = groupOf.get(node)
      references.push({
        file, line, binding: lookup.binding, name: lookup.name, ...target, ...group === undefined ? {} : { group },
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

/**
 * Check literal lookups against the stylesheets they import.
 * @param references - lookups from {@link collectClassReferences}.
 * @param lookup - parsed module for a repository-relative path, or undefined when absent.
 * @returns undefined-class, missing-stylesheet, and state-only findings, one per
 *   distinct file, line, class, and kind.
 */
export function findClassViolations(
  references: ClassReference[],
  lookup: (stylesheet: string) => CssModuleInfo | undefined,
): Violation[] {
  const violations: Violation[] = []
  const seen = new Set<string>()
  const add = (reference: ClassReference, kind: ViolationKind, subject: string): void => {
    const key = `${reference.file}:${String(reference.line)}:${kind}:${subject}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ file: reference.file, line: reference.line, kind, subject, stylesheet: reference.stylesheet })
  }
  const missing = new Set<string>()
  // Per className group: whether each lookup styles the element at rest.
  const groups = new Map<string, { reference: ClassReference; atRest: boolean; stateOnly: boolean }[]>()
  for (const reference of references) {
    const info = lookup(reference.stylesheet)
    let atRest = false
    let stateOnly = false
    if (info === undefined) {
      const once = `${reference.file}\0${reference.stylesheet}`
      if (!missing.has(once)) add(reference, 'missing-stylesheet', reference.stylesheet)
      missing.add(once)
    } else if (!info.classes.has(reference.name) && !info.keyframes.has(reference.name)) {
      add(reference, 'undefined-class', reference.name)
    } else {
      stateOnly = info.classes.get(reference.name)?.standalone === false
      atRest = !stateOnly
    }
    if (reference.group !== undefined) {
      const key = `${reference.file}\0${String(reference.group)}`
      groups.set(key, [...groups.get(key) ?? [], { reference, atRest, stateOnly }])
    }
  }
  for (const members of groups.values()) {
    if (members.some(member => member.atRest)) continue
    for (const { reference, stateOnly } of members) {
      if (stateOnly) add(reference, 'state-only', reference.name)
    }
  }
  return violations
}

/** Repository-relative `/` paths under the governed trees that match `pattern`. */
function listFiles(pattern: string): string[] {
  const found: string[] = []
  for (const base of SCAN_GLOBS) {
    for (const rel of globSync(`${base}/${pattern}`, { cwd: root })) {
      const path = rel.split(sep).join('/')
      if (!path.split('/').includes('node_modules')) found.push(path)
    }
  }
  return found.sort()
}

function explain(violation: Violation, byFile: ReadonlyMap<string, ClassReference>): string {
  const { subject, stylesheet } = violation
  const reference = byFile.get(`${violation.file}:${String(violation.line)}:${subject}`)
  const lookup = reference === undefined ? subject : `${reference.binding}.${subject}`
  switch (violation.kind) {
    case 'undefined-class':
      return `${lookup} — no selector in ${stylesheet} declares .${subject}, so it resolves to undefined and renders unstyled`
    case 'missing-stylesheet':
      return `stylesheet not found: ${subject}`
    case 'composes':
      return `${subject} — the plugin bundler keeps only each class's own exported name, so composed classes are dropped`
    case 'state-only':
      return `${lookup} — every rule for .${subject} in ${stylesheet} is a pseudo-state rule, so the class styles nothing on its own`
  }
}

function main(): void {
  const modules = new Map<string, CssModuleInfo | undefined>()
  const load = (path: string): CssModuleInfo | undefined => {
    if (!modules.has(path)) {
      const absolute = join(root, path)
      modules.set(path, existsSync(absolute) ? parseCssModule(readFileSync(absolute, 'utf8')) : undefined)
    }
    return modules.get(path)
  }

  const violations: Violation[] = []
  const stylesheets = listFiles('**/*.module.css')
  for (const path of stylesheets) {
    const info = load(path)
    if (info !== undefined) violations.push(...findComposesViolations(path, info))
  }

  const references: ClassReference[] = []
  const sources = listFiles('**/*.{ts,tsx}').filter(path => !path.endsWith('.d.ts'))
  for (const path of sources) {
    references.push(...collectClassReferences(path, readFileSync(join(root, path), 'utf8')))
  }
  violations.push(...findClassViolations(references, load))

  if (violations.length > 0) {
    const byLocation = new Map(references.map(ref => [`${ref.file}:${String(ref.line)}:${ref.name}`, ref]))
    violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    console.error(`verify-client-css-classes: ${violations.length} unresolved, composed, or state-only CSS Module class(es):`)
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} -> ${explain(violation, byLocation)}`)
    }
    console.error('Declare the class in the stylesheet, drop the dead reference, or apply the shared class in TSX (clsx);')
    console.error('give a state-only class its resting rule, or apply it beside the class it modifies.')
    process.exit(1)
  }
  console.log(`verify-client-css-classes: ${String(stylesheets.length)} CSS Modules, ${String(references.length)} class references, every one resolves.`)
}

if (import.meta.main) main()
