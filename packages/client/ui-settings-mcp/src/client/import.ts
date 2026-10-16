/**
 * Paste-import parsing: OpenCode `mcp` configuration and the standard
 * `mcpServers` JSON shape, reduced to this deployment's server rows. The
 * parser is intentionally client-local: nothing here touches the wire until
 * the operator confirms the parsed preview.
 *
 * @module
 */

/** One parsed server awaiting the operator's confirmation. */
export interface ParsedMcpServer {
  /** Stable identity candidate; conflicts are the caller's to resolve. */
  id: string
  /** Public tool namespace candidate. */
  serverName: string
  /** Transport selected by the pasted shape. */
  transport: 'stdio' | 'streamable-http'
  /** Stdio executable; absent for remote entries. */
  command?: string
  /** Stdio arguments. */
  args: string[]
  /** Stdio environment additions. */
  env: Record<string, string>
  /** Stdio working directory. */
  cwd: string
  /** Remote endpoint URL. */
  url?: string
  /** Remote request headers. */
  headers: Record<string, string>
}

/** Why a paste could not be reduced to server rows. */
export class McpImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpImportError'
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Sanitize one pasted name into a legal id/serverName, or reject it. */
function nameOf(raw: string, kind: 'id' | 'serverName'): string {
  const cleaned = raw.trim().replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, kind === 'id' ? 64 : 32)
  if (!ID_PATTERN.test(cleaned)) throw new McpImportError(`invalid server name "${raw}"`)
  return cleaned
}

/** Parse one KEY=VALUE per line into a record; blank lines and comments skip. */
function parseKeyValueLines(lines: string): Record<string, string> {
  const record: Record<string, string> = {}
  for (const line of lines.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new McpImportError(`invalid KEY=VALUE line "${trimmed}"`)
    record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return record
}

/** Interpret one OpenCode entry (`type: local|remote`, command string+args or array). */
function fromOpencode(name: string, value: Record<string, unknown>): ParsedMcpServer {
  const type = value.type
  if (type === 'local') {
    const [command, args] = commandOf(name, value)
    return {
      id: nameOf(name, 'id'),
      serverName: nameOf(name, 'serverName'),
      transport: 'stdio',
      command,
      args,
      env: recordOf(value.env),
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      headers: {},
    }
  }
  if (type === 'remote') {
    if (typeof value.url !== 'string' || value.url === '') throw new McpImportError(`OpenCode entry "${name}" needs a url`)
    return {
      id: nameOf(name, 'id'),
      serverName: nameOf(name, 'serverName'),
      transport: 'streamable-http',
      args: [],
      env: {},
      cwd: '',
      url: value.url,
      headers: recordOf(value.headers),
    }
  }
  throw new McpImportError(`OpenCode entry "${name}" has unsupported type ${String(type)}`)
}

/**
 * Reduce one entry's `command` to the executable and its arguments; accepts
 * the array form (command pieces) and the string+args form.
 */
function commandOf(name: string, value: Record<string, unknown>): [string, string[]] {
  if (Array.isArray(value.command)) {
    if (value.command.length === 0 || typeof value.command[0] !== 'string') {
      throw new McpImportError(`entry "${name}" has an empty command array`)
    }
    return [value.command[0], value.command.slice(1).filter((arg): arg is string => typeof arg === 'string')]
  }
  if (typeof value.command === 'string' && value.command !== '') {
    return [value.command, Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : []]
  }
  throw new McpImportError(`entry "${name}" needs a command`)
}

/** Interpret one standard `mcpServers` entry (command string, optional url). */
function fromStandard(name: string, value: Record<string, unknown>): ParsedMcpServer {
  const env = recordOf(value.env)
  const cwd = typeof value.cwd === 'string' ? value.cwd : ''
  if (typeof value.url === 'string' && value.url !== '') {
    return {
      id: nameOf(name, 'id'),
      serverName: nameOf(name, 'serverName'),
      transport: 'streamable-http',
      args: [],
      env: {},
      cwd: '',
      url: value.url,
      headers: recordOf(value.headers),
    }
  }
  if (value.command !== undefined) {
    const [command, args] = commandOf(name, value)
    return {
      id: nameOf(name, 'id'),
      serverName: nameOf(name, 'serverName'),
      transport: 'stdio',
      command,
      args,
      env,
      cwd,
      headers: {},
    }
  }
  throw new McpImportError(`entry "${name}" has neither a command nor a url`)
}

function recordOf(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpImportError('env/headers must be an object')
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new McpImportError(`env/headers value of "${key}" must be a string`)
    record[key] = entry
  }
  return record
}

/**
 * Parse pasted configuration text into server rows.
 *
 * Accepted containers, checked in order: OpenCode's `mcp` object, the
 * standard `mcpServers` object, and a bare single server object with a
 * `command` or `url` (treated as one standard entry).
 *
 * @param text - pasted configuration text.
 * @returns every recognized server in container order.
 * @throws {McpImportError} when the text is not parsable JSON or carries no
 *   recognizable container.
 */
export function parseMcpImport(text: string): ParsedMcpServer[] {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new McpImportError(`not valid JSON (${error instanceof Error ? error.message : /* v8 ignore next -- JSON.parse failures are always SyntaxError instances */ 'parse failed'})`)
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new McpImportError('the pasted text is not a JSON object')
  }
  const root = document as Record<string, unknown>
  const container = root.mcp ?? root.mcpServers
  if (container === undefined) {
    // A bare single entry is accepted for one-server pastes.
    if ('command' in root || 'url' in root) return [fromStandard('imported', root)]
    throw new McpImportError('no "mcp" or "mcpServers" container found')
  }
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    throw new McpImportError('the container must be a JSON object')
  }
  const opencode = root.mcp !== undefined
  const servers: ParsedMcpServer[] = []
  for (const [name, value] of Object.entries(container) as Array<[string, Record<string, unknown>]>) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new McpImportError(`entry "${name}" must be an object`)
    }
    servers.push(opencode ? fromOpencode(name, value) : fromStandard(name, value))
  }
  if (servers.length === 0) throw new McpImportError('the container is empty')
  return servers
}

/**
 * Format one record back into KEY=VALUE lines for editor text areas.
 * @param record - the record to render.
 * @returns one KEY=VALUE line per entry, keys sorted.
 */
export function formatKeyValueLines(record: Record<string, string>): string {
  return Object.keys(record).sort().map(key => `${key}=${record[key]}`).join('\n')
}

export { parseKeyValueLines }
