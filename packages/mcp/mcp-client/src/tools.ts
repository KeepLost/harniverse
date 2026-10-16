/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
 * under deterministic server-qualified public names, and handles re-sync when
 * the server's tool list changes.
 *
 * Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * constraints. The raw name is only ever sent on the wire (`tools/call`); the
 * public name is never parsed to recover it.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonValue } from '@deepseek-ai/dsh-tools'

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  /** Whether a registry conflict is contained or rejects this synchronization. */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
}

/** State for one sync generation: the current set of disposers keyed by public name. */
export type ToolDisposers = Map<string, () => void>

/** Canonical MCP result exposed to PTC without discarding protocol blocks. */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Raw result record: the bridge owns JSON-value validation after transport. */
export const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/**
 * Guard one paginated drain against a server that repeats a continuation
 * cursor it already issued — otherwise the drain would loop forever.
 * @param serverName - the configured server, for diagnostics.
 * @returns a checker that records each seen cursor and rejects a repeat.
 */
export function cursorGuard(serverName: string): (cursor: string | undefined) => void {
  const seen = new Set<string>()
  let pages = 0
  return (cursor) => {
    if (++pages > 128) throw new Error(`mcp-client(${serverName}): pagination exceeds 128 pages`)
    if (cursor === undefined) return
    if (typeof cursor !== 'string') throw new Error(`mcp-client(${serverName}): invalid continuation cursor`)
    if (seen.has(cursor)) {
      throw new Error(`mcp-client(${serverName}): server repeated continuation cursor "${cursor}" — invalid pagination`)
    }
    seen.add(cursor)
  }
}

/** One MCP tool's advertisement exactly as a live generation listed it. */
export interface McpToolDescriptor {
  /** The server's own wire name; only ever sent back on `tools/call`. */
  readonly rawName: string
  /** Server-provided description; empty when the server omits one. */
  readonly description: string
  /** Server-provided input schema (a JSON Schema object), passed through verbatim. */
  readonly inputSchema: Record<string, unknown>
  /** Server-advertised output schema, already filtered to supported vocabulary. */
  readonly outputSchema?: JsonSchemaNode
  /** Whether the server demands task-based execution this bridge rejects. */
  readonly taskRequired: boolean
}

/**
 * Drain `tools/list` pagination into the complete descriptor list.
 *
 * The fetch half of every tool sync: no registry contact, so a failure leaves
 * the previous generation untouched regardless of the caller.
 *
 * @param client - connected MCP client generation to list from.
 * @param serverName - server namespace for diagnostics.
 * @param isCurrent - ownership guard checked before every page.
 * @returns every advertised tool in server order.
 */
export async function listToolDescriptors(
  client: Client,
  serverName: string,
  isCurrent: () => boolean,
): Promise<McpToolDescriptor[]> {
  const descriptors: McpToolDescriptor[] = []
  const guard = cursorGuard(serverName)
  let cursor: string | undefined
  do {
    if (!isCurrent()) return descriptors
    guard(cursor)
    const response = await listToolsUncached(client, cursor)
    if (!isCurrent()) return descriptors
    for (const tool of response.tools) {
      if (descriptors.some(descriptor => descriptor.rawName === tool.name)) {
        throw new Error(
          `mcp-client(${serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
        )
      }
      const outputSchema = supportedOutputSchema(tool.outputSchema)
      descriptors.push({
        rawName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...outputSchema === undefined ? {} : { outputSchema },
        taskRequired: tool.execution?.taskSupport === 'required',
      })
    }
    cursor = response.nextCursor
  } while (cursor !== undefined)
  return descriptors
}

/** Executor-facing raw call: one server tool by wire name with timeout/signal. */
export type McpToolCall = (
  rawName: string,
  args: Record<string, unknown>,
  exec: ToolExecution,
) => Promise<unknown>

/**
 * Build the registry-facing definition for one descriptor, routing execution
 * through the supplied call. The shared-connection registrar and the
 * standalone bridge produce identical definitions this way.
 *
 * @param serverName - server namespace used in the public tool name.
 * @param descriptor - the advertised tool to project.
 * @param call - raw `tools/call` route owned by the live connection.
 * @returns the complete tool definition with normalized MCP result mapping.
 */
export function descriptorToDefinition(
  serverName: string,
  descriptor: McpToolDescriptor,
  call: McpToolCall,
): ToolDefinition {
  return {
    name: publicToolName(serverName, descriptor.rawName),
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    output: createOutput(descriptor.rawName, descriptor.outputSchema),
    execute: async (args, exec) => {
      if (descriptor.taskRequired) {
        throw new Error(`Tool "${descriptor.rawName}" requires task-based execution, which this bridge does not support`)
      }
      return normalizeCallResult(
        await call(descriptor.rawName, (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>, exec),
        descriptor.rawName,
      )
    },
  }
}

/** List without mutating the SDK's per-page output-validator cache. */
function listToolsUncached(client: Client, cursor?: string) {
  return client.request(
    { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListToolsResultSchema,
  )
}

/** Call without the SDK pre-validating an output schema the bridge may not support. */
function callToolUncached(
  client: Client,
  rawName: string,
  args: Record<string, unknown>,
  exec: ToolExecution,
  opts: ToolBridgeOptions,
) {
  return client.request(
    { method: 'tools/call', params: { name: rawName, arguments: args } },
    RawCallToolResultSchema,
    {
      signal: exec.signal,
      timeout: opts.toolCallTimeoutMs,
    },
  )
}

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)`: the clean case is
 * `mcp__<serverName>__<rawName>` verbatim. When character replacement or
 * truncation to the DeepSeek function-name contract (64 chars,
 * `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into the
 * same public name.
 *
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Sync the MCP server's tool list into the harness ToolRuntime.
 *
 * Two phases keep the swap safe:
 *
 * 1. Fetch: drain uncached `tools/list` pagination and build the full next
 *    generation of `ToolDefinition`s under public names. Any failure here
 *    (network error, duplicate raw name in the server's list) rejects and
 *    leaves the previous generation registered untouched.
 * 2. Swap: dispose the previous generation, register the new one. A registry
 *    conflict here can only mean a foreign registration squats on this
 *    server's `mcp__<serverName>__` namespace — the partial generation is
 *    rolled back (zero tools from this server) and logged. Initial strict
 *    synchronization may propagate the conflict so its parent transaction
 *    rejects; ordinary clients and later re-syncs return an empty map.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: server namespace and per-call timeout.
 * @param previous - Disposer map from the prior sync generation; disposed
 *   during the swap phase (only after the fetch phase succeeded).
 * @param isCurrent - connection ownership guard checked before every page and publication.
 * @param published - synchronous observer that installs captured restrictions before yielding.
 * @returns A map of registered public tool names to their unregister
 *   disposers — the exact set of live registrations owned by this server.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
  isCurrent: () => boolean = () => true,
  published: (next: ToolDisposers) => void = () => {},
): Promise<ToolDisposers> {
  // Phase 1: fetch and build the next generation without touching the registry.
  // Descriptor raw-name uniqueness (and therefore public-name uniqueness — the
  // identity hash never collapses two raw names) is already enforced by the drain.
  const descriptors = await listToolDescriptors(client, opts.serverName, isCurrent)
  if (!isCurrent()) return previous
  const definitions = new Map<string, ToolDefinition>()
  for (const descriptor of descriptors) {
    const definition = descriptorToDefinition(opts.serverName, descriptor, (rawName, args, exec) =>
      callToolUncached(client, rawName, args, exec, opts))
    definitions.set(definition.name, definition)
  }

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, ctx.tools.register(definition))
    }
  } catch (error) {
    // A conflict on an `mcp__<serverName>__`-qualified name means a foreign
    // registration occupies this server's namespace. Roll back so the model
    // sees either the full generation or none of it — never a partial set.
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    if (opts.registrationFailure === 'throw') throw error
    const empty: ToolDisposers = new Map()
    published(empty)
    return empty
  }
  published(disposers)
  return disposers
}

/**
 * The shape we read from each MCP content block. Intentionally looser than the
 * SDK's `ContentBlock` type: we're at a network trust boundary (data arrives
 * from an external MCP server process via JSON-RPC), so fields that the SDK
 * declares required may be absent at runtime if the server is buggy.
 */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** Build the canonical result schema and existing Native text projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value as unknown as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/** Loose reading shape of one raw `tools/call` result at the trust boundary. */
interface RawCallToolResult {
  content?: unknown
  toolResult?: unknown
  isError?: unknown
  structuredContent?: unknown
}

/**
 * Map one raw `tools/call` result to the canonical harness result. The SDK may
 * return a legacy `toolResult` shape; a non-array `content` normalizes to a
 * text block, and MCP `isError: true` throws so the ToolRuntime catch path
 * produces an `isError` result for the model.
 *
 * @param result - raw call result exactly as the transport returned it.
 * @param rawName - the server's own tool name, for diagnostics.
 * @returns the canonical `McpResult` content/structuredContent pair.
 */
function normalizeCallResult(result: unknown, rawName: string): McpResult {
  const raw = (typeof result === 'object' && result !== null ? result : {}) as RawCallToolResult
  if (!Array.isArray(raw.content)) {
    const rendered: unknown = 'toolResult' in raw
      ? JSON.stringify(raw.toolResult)
      : '(no output)'
    const text = typeof rendered === 'string' ? rendered : '(no output)'
    if (raw.isError === true) throw new Error(text)
    return {
      content: [{ type: 'text', text }],
      ...raw.structuredContent !== undefined
        ? { structuredContent: raw.structuredContent as JsonValue }
        : {},
    }
  }

  // Trust boundary: the transport's return type erases to `any[]` due to the
  // union of CallToolResult | CompatibilityCallToolResult; extractText
  // validates each element.
  const content = raw.content as unknown as JsonValue[]
  const text = extractText(content, rawName)

  // MCP isError → throw so ToolRuntime produces an isError result for the model.
  if (raw.isError === true) {
    throw new Error(text)
  }

  return {
    content,
    ...raw.structuredContent !== undefined
      ? { structuredContent: raw.structuredContent as JsonValue }
      : {},
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Defensive: fields that the MCP spec declares required (mimeType, text) are
 * guarded with fallbacks because this is a network trust boundary.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const parts: string[] = []

  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }

  return parts.join('\n') || `(${toolName} returned no text content)`
}
