/**
 * Shared path-glob contract for read-only Workspace file search.
 *
 * Supports the subset a file filter needs: `*` (any run except `/`), `?` (one
 * character except `/`), `**` (any run including `/`), `{a,b}` alternation, and
 * `[abc]` / `[!a-z]` classes. Matching is case-insensitive because the search it
 * scopes matches names case-insensitively, and a filter that disagreed with its
 * query would silently drop hits on case-insensitive filesystems.
 *
 * Scope follows the pattern's shape, so the common cases need no syntax:
 *  - no separator (`*.py`) matches a path's basename, at any depth;
 *  - with a separator (`src/**` + `/*.ts`) matches the whole relative path;
 *  - trailing `/` (`dist/`) matches a directory and everything beneath it.
 *
 * Compilation is deliberately not a dependency: the accepted syntax is fixed by
 * this contract, and a general glob library would widen it silently.
 */

/** One compiled include or exclude list. */
export interface WorkspaceGlobFilter {
  /** True when no usable pattern was supplied, so the list is inert. */
  readonly empty: boolean
  /**
   * Whether a workspace-relative path matches any pattern.
   * @param path - workspace-relative path with `/` separators, no leading `./`.
   * @returns true when at least one pattern matches.
   */
  matches(path: string): boolean
  /**
   * Whether a directory itself is excluded, so the walk may skip its subtree.
   *
   * Distinct from `matches`: a directory pattern (`dist/`) covers the directory,
   * while a file pattern (`*.py`) never excludes a directory even if the name
   * happens to fit.
   * @param path - workspace-relative directory path.
   * @returns true when the directory and everything beneath it is excluded.
   */
  matchesDirectory(path: string): boolean
  /**
   * Whether a directory may still contain a match, used to prune the walk.
   *
   * A pattern anchored to a subtree (`src/**`) cannot match outside it. An
   * unanchored pattern (`*.py`) matches at any depth and never prunes.
   * @param path - workspace-relative directory path, '' for the root.
   * @returns true when a match may exist beneath this directory.
   */
  mayContainMatch(path: string): boolean
}

/**
 * What a compiled pattern's expression is tested against:
 *  - `basename`  the path's last segment (`*.py`);
 *  - `path`      the whole relative path (`src/**` + `/*.ts`);
 *  - `segment`   every ancestor directory name (`node_modules/`);
 *  - `subtree`   every ancestor directory path (`src/generated/`).
 */
type PatternScope = 'basename' | 'path' | 'segment' | 'subtree'

interface CompiledPattern {
  /** Matcher for whichever string `scope` selects. */
  readonly test: GlobMatcher
  readonly scope: PatternScope
  /** Literal directory prefix a match must start with, '' when unanchored. */
  readonly anchor: string
  /** Directory root covered by a path pattern ending in `/**`. */
  readonly directoryTest?: GlobMatcher
  /** Directory ancestor matcher for a subtree pattern with a trailing recursive segment. */
  readonly subtreeTest?: GlobMatcher
  /** Maximum directory depth that can still contain a path-scoped file match. */
  readonly maxDirectoryDepth?: number
}

type GlobMatcher = (value: string) => boolean
type GlobTransitionKind = 'test' | 'not-slash' | 'any' | 'slash'

interface GlobTransition {
  readonly to: number
  readonly kind: GlobTransitionKind
  readonly test?: RegExp
}

interface GlobState {
  readonly epsilon: number[]
  readonly transitions: GlobTransition[]
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, character => `\\${character}`)
}

const literalTests = new Map<string, RegExp>()
const LITERAL_TEST_CACHE_LIMIT = 256

function literalTest(character: string): RegExp {
  let test = literalTests.get(character)
  if (test === undefined) {
    // A full cache always yields a key, so eviction reads the iterator rather
    // than testing for one.
    for (const oldest of literalTests.keys()) {
      if (literalTests.size < LITERAL_TEST_CACHE_LIMIT) break
      literalTests.delete(oldest)
    }
    test = new RegExp(`^${escapeRegExp(character)}$`, 'iu')
    literalTests.set(character, test)
  }
  return test
}

function literalMatcher(pattern: string): GlobMatcher {
  const tests = Array.from(pattern, literalTest)
  return (candidate) => {
    const characters = Array.from(candidate)
    return characters.length === tests.length && tests.every((test, index) => test.test(characters[index] as string))
  }
}

function closingBrace(pattern: string, opening: number): number {
  let depth = 0
  for (let index = opening; index < pattern.length; index++) {
    const character = pattern.charAt(index)
    if (character === '{') depth++
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}

/** Compile the fixed glob syntax to an NFA; matching has no regex quantifiers. */
function compileMatcher(pattern: string): GlobMatcher {
  const states: GlobState[] = []
  const state = (): number => {
    states.push({ epsilon: [], transitions: [] })
    return states.length - 1
  }
  // Every id in this machine came from `state()`, which pushes before it
  // returns, so an id always addresses a state.
  const at = (id: number): GlobState => states[id] as GlobState
  const epsilon = (from: number, to: number): void => { at(from).epsilon.push(to) }
  const transition = (from: number, value: GlobTransition): void => { at(from).transitions.push(value) }

  const sequence = (start: number, offset: number, inBrace: boolean): {
    end: number
    offset: number
    delimiter?: ',' | '}'
  } => {
    let current = start
    let index = offset
    while (index < pattern.length) {
      const character = pattern.charAt(index)
      if (inBrace && (character === ',' || character === '}')) {
        return { end: current, offset: index, delimiter: character }
      }
      if (character === '{' && closingBrace(pattern, index) !== -1) {
        const after = state()
        let branchOffset = index + 1
        for (;;) {
          const branchStart = state()
          epsilon(current, branchStart)
          const branch = sequence(branchStart, branchOffset, true)
          epsilon(branch.end, after)
          if (branch.delimiter === ',') {
            branchOffset = branch.offset + 1
            continue
          }
          if (branch.delimiter !== '}') throw new Error('unclosed brace')
          index = branch.offset + 1
          current = after
          break
        }
        continue
      }
      if (character === '*') {
        const next = state()
        epsilon(current, next)
        if (pattern.charAt(index + 1) === '*') {
          if (pattern.charAt(index + 2) === '/') {
            transition(current, { to: current, kind: 'any' })
            transition(current, { to: next, kind: 'slash' })
            index += 3
          } else {
            transition(current, { to: current, kind: 'any' })
            index += 2
          }
        } else {
          transition(current, { to: current, kind: 'not-slash' })
          index++
        }
        current = next
        continue
      }
      if (character === '?') {
        const next = state()
        transition(current, { to: next, kind: 'not-slash' })
        current = next
        index++
        continue
      }
      if (character === '[') {
        // Every `[` was proven to have a `]` before compilation started, so
        // the close is an index rather than a possibility.
        const close = pattern.indexOf(']', index + 1)
        const body = pattern.slice(index + 1, close)
        if (body.includes('[')) throw new Error('nested character class')
        const negated = body.startsWith('!') || body.startsWith('^')
        const members = (negated ? body.slice(1) : body).replaceAll(/[\\^\]]/gu, member => `\\${member}`)
        if (members === '') throw new Error('empty character class')
        const next = state()
        transition(current, { to: next, kind: 'test', test: new RegExp(`^[${negated ? '^' : ''}${members}]$`, 'iu') })
        current = next
        index = close + 1
        continue
      }
      const literal = String.fromCodePoint(pattern.codePointAt(index) as number)
      const next = state()
      transition(current, { to: next, kind: 'test', test: literalTest(literal) })
      current = next
      index += literal.length
    }
    return { end: current, offset: index }
  }

  try {
    for (let index = 0; index < pattern.length; index++) {
      if (pattern.charAt(index) === '[' && pattern.indexOf(']', index + 1) === -1) throw new Error('unclosed character class')
    }
    const start = state()
    const compiled = sequence(start, 0, false)
    const closures = states.map((_, initial) => {
      const reached = new Set<number>()
      const pending = [initial]
      while (pending.length > 0) {
        const current = pending.pop() as number
        if (reached.has(current)) continue
        reached.add(current)
        pending.push(...at(current).epsilon)
      }
      return [...reached]
    })
    // Closures are built one per state, so a state id addresses one.
    const closureOf = (id: number): readonly number[] => closures[id] as readonly number[]
    return (candidate) => {
      let active = new Uint8Array(states.length)
      for (const reached of closureOf(start)) active[reached] = 1
      for (const character of candidate) {
        const next = new Uint8Array(states.length)
        for (let index = 0; index < states.length; index++) {
          if (active[index] !== 1) continue
          for (const edge of at(index).transitions) {
            const matches = edge.kind === 'any'
              || edge.kind === 'slash' && character === '/'
              || edge.kind === 'not-slash' && character !== '/'
              || edge.kind === 'test' && edge.test?.test(character) === true
            if (!matches) continue
            for (const reached of closureOf(edge.to)) next[reached] = 1
          }
        }
        active = next
      }
      return active[compiled.end] === 1
    }
  } catch {
    // A malformed range is a literal filename pattern rather than a request failure.
    return literalMatcher(pattern)
  }
}

/**
 * Leading literal directory segments of a pattern, used for walk pruning.
 * @param pattern - glob body.
 * @returns the literal prefix ending in `/`, or '' when the first segment is dynamic.
 */
function literalAnchor(pattern: string): string {
  let anchor = ''
  for (const segment of pattern.split('/').slice(0, -1)) {
    if (/[*?{}[\]]/u.test(segment)) break
    anchor += `${segment}/`
  }
  return anchor
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  const valueCharacters = Array.from(value)
  const prefixCharacters = Array.from(prefix)
  return prefixCharacters.length <= valueCharacters.length && prefixCharacters.every((character, index) => (
    literalTest(character).test(valueCharacters[index] as string)
  ))
}

function compilePattern(raw: string): CompiledPattern | undefined {
  const trimmed = raw.trim()
  // Workspace paths are relative. Accept a conventional root marker without
  // requiring the caller to know that internal representation.
  const rooted = trimmed.startsWith('./') || trimmed.startsWith('/')
  const normalized = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  const recursiveSubtree = normalized.endsWith('/**/')
  const body = normalized.replace(/\/+$/u, '')
  if (body === '') return undefined
  const multiSegment = body.includes('/')
  const scope: PatternScope = normalized.endsWith('/')
    // A bare directory name applies at any depth, the same way `*.py` does;
    // a multi-segment one is a specific subtree.
    ? multiSegment || rooted ? 'subtree' : 'segment'
    : multiSegment || rooted ? 'path' : 'basename'
  const test = compileMatcher(body)
  const rootSubtree = rooted && body === '**'
  const directoryBody = scope === 'path' && (body.endsWith('/**') || rootSubtree)
    ? rootSubtree ? '' : body.slice(0, -3)
    : undefined
  let directoryTest: GlobMatcher | undefined
  if (directoryBody !== undefined) {
    directoryTest = rootSubtree ? () => true : compileMatcher(directoryBody)
  }
  const subtreeTest = scope === 'subtree' && recursiveSubtree
    ? compileMatcher(body.slice(0, -3))
    : undefined
  const literalPathAnchor = literalAnchor(body)
  const literalDirectory = scope === 'subtree' && !/[*?{}[\]]/u.test(body)
  const anchor = literalDirectory ? `${body}/` : literalPathAnchor
  const maxDirectoryDepth = scope === 'path' && !body.includes('**') ? body.split('/').length - 1 : undefined
  return {
    test, scope, anchor,
    ...(directoryTest === undefined ? {} : { directoryTest }),
    ...(subtreeTest === undefined ? {} : { subtreeTest }),
    ...(maxDirectoryDepth === undefined ? {} : { maxDirectoryDepth }),
  }
}

/**
 * Whether one pattern matches a candidate.
 * @param pattern - compiled pattern.
 * @param path - workspace-relative path.
 * @param isDirectory - true when the candidate is the directory itself, which
 *   makes its own last segment an ancestor for directory-scoped patterns.
 * @returns true on a match.
 */
function matchesPattern(pattern: CompiledPattern, path: string, isDirectory: boolean): boolean {
  const segments = path.split('/')
  switch (pattern.scope) {
    case 'basename': return !isDirectory && pattern.test(segments.at(-1) as string)
    case 'path': return isDirectory ? pattern.directoryTest?.(path) === true : pattern.test(path)
    // Directory patterns cover the directory itself and its whole subtree, so
    // every ancestor is a candidate — plus the last segment when the candidate
    // is the directory being considered for the walk.
    case 'segment': return segments.slice(0, isDirectory ? undefined : -1).some(segment => pattern.test(segment))
    case 'subtree': {
      const candidates = segments.slice(0, isDirectory ? undefined : -1)
      return candidates.some((_, index) => {
        const candidate = candidates.slice(0, index + 1).join('/')
        return pattern.subtreeTest === undefined ? pattern.test(candidate) : pattern.subtreeTest(candidate)
      })
    }
  }
}

const PASS_EVERYTHING: WorkspaceGlobFilter = {
  empty: true,
  matches: () => true,
  matchesDirectory: () => false,
  mayContainMatch: () => true,
}

const MATCH_NOTHING: WorkspaceGlobFilter = {
  empty: true,
  matches: () => false,
  matchesDirectory: () => false,
  mayContainMatch: () => false,
}

/**
 * Compile one glob list into a reusable filter.
 *
 * Patterns are bounded at the API boundary; a pattern that passes validation but
 * carries no usable body (whitespace, a bare `/`) is dropped, and a list of only
 * such patterns behaves as an absent list.
 * @param patterns - raw glob patterns, or undefined for no filter.
 * @param whenEmpty - behaviour with no usable pattern: `pass` for an include
 *   list (unfiltered search), `reject` for an exclude list (nothing excluded).
 * @returns the compiled filter.
 */
export function compileGlobFilter(
  patterns: readonly string[] | undefined,
  whenEmpty: 'pass' | 'reject',
): WorkspaceGlobFilter {
  const compiled = (patterns ?? [])
    .map(compilePattern)
    .filter((entry): entry is CompiledPattern => entry !== undefined)
  if (compiled.length === 0) return whenEmpty === 'pass' ? PASS_EVERYTHING : MATCH_NOTHING
  return {
    empty: false,
    matches: path => compiled.some(pattern => matchesPattern(pattern, path, false)),
    matchesDirectory: path => compiled.some(pattern => matchesPattern(pattern, path, true)),
    mayContainMatch(path) {
      const prefix = path === '' ? '' : `${path}/`
      const depth = path === '' ? 0 : path.split('/').length
      return compiled.some(({ anchor, maxDirectoryDepth }) => {
        return (maxDirectoryDepth === undefined || depth <= maxDirectoryDepth)
          && (anchor === '' || startsWithCaseInsensitive(anchor, prefix) || startsWithCaseInsensitive(prefix, anchor))
      })
    },
  }
}

/**
 * Directory patterns skipped unless the caller supplies its own exclude list:
 * dependency trees and build output, where a name search finds only noise.
 */
export const WORKSPACE_SEARCH_DEFAULT_EXCLUDES: readonly string[] = [
  '.git/',
  'node_modules/',
  '.pnpm-store/',
  '.venv/',
  '__pycache__/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  'dist/',
  'build/',
  'coverage/',
  'lib/',
  'out/',
  'target/',
]
