/** Strict validation at the trusted machine's private RPC boundary. */
import { z } from 'zod'

/** Absolute POSIX path without NUL bytes; the machine's canonical target identity. */
export const remotePath = z.string().startsWith('/').refine(value => !value.includes('\0'))
/** A resolved filesystem target: canonical key plus display path. */
export const targetSchema = z.object({ targetKey: remotePath, displayPath: z.string() }).strict()
/** Post-`stat` file facts, without the symlink dimension. */
export const infoSchema = z.object({ version: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.number().nonnegative().optional() }).strict()
/** Post-`lstat` facts, including the symlink type. */
export const pathInfoSchema = infoSchema.extend({ type: z.enum(['file', 'directory', 'symlink', 'other']) })
/** A sandbox execution policy resolved on the execution machine. */
export const policySchema = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']), workspaceRoot: remotePath, sessionId: z.string().optional() }).strict()
/** One `listDir` entry: name, kind, resolved target, and version when known. */
export const entriesSchema = z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']), target: targetSchema, version: z.string().optional(), size: z.number().nonnegative().optional() }).strict())
/** A write intent: create only when absent, or replace pinned to a known version. */
export const intentSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(), z.object({ kind: z.literal('replaceIfVersion'), version: z.string() }).strict()])
/** A `str-replace-editor` style edit request. */
export const editSchema = z.object({ oldString: z.string(), newString: z.string(), replaceAll: z.boolean() }).strict()
/** Acknowledgement of an applied write: operation kind, versions, and before/after text. */
export const writeResultSchema = z.object({ operation: z.enum(['create', 'update']), version: z.string(), before: z.string().nullable(), after: z.string() }).strict()
/** Acknowledgement of an applied edit: new version and before/after text. */
export const editResultSchema = z.object({ version: z.string(), before: z.string(), after: z.string() }).strict()
/** Spawn environment mapping; `null` values delete the variable on the machine. */
export const environmentSchema = z.record(z.string(), z.string().nullable())
const collection = z.object({
  maxBytes: z.number().int().positive().max(1024 * 1024),
  spill: z.object({ maxBytes: z.number().int().positive() }).strict().optional(),
}).strict()
/** A process spawn request: argv, cwd, env, grace, limits, and ordinary-or-terminal stdio selection. */
export const spawnSchema = z.object({
  argv: z.array(z.string().refine(value => !value.includes('\0'))).min(1), cwd: remotePath,
  env: environmentSchema.optional(), graceMs: z.number().int().positive().max(30_000),
  limits: z.object({ maxMemoryBytes: z.number().int().positive().optional() }).strict().optional(),
  stdio: z.object({
    stdin: z.union([z.literal('ignore'), z.literal('pipe'), z.object({ data: z.string() }).strict()]),
    stdout: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
    stderr: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
  }).strict().optional(),
  terminal: z.object({
    rows: z.number().int().positive(), cols: z.number().int().positive(), term: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().refine(value => (value.stdio === undefined) !== (value.terminal === undefined), 'select ordinary or terminal execution')
/** Server-assigned process identifier. */
export const processIdSchema = z.uuid()
/** How a process ended: exit code and/or terminating signal. */
export const outcomeSchema = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict()
/** Terminal foreground facts: process group id and whether input is awaited; `null` when not in the foreground. */
export const foregroundSchema = z.object({ processGroupId: z.number().int().positive(), inputWaiting: z.boolean() }).strict().nullable()
/** One bounded output read: text, next offset, lossy flag, and optional spill path. */
export const outputReadSchema = z.object({
  text: z.string(), nextOffset: z.number().int().nonnegative(), lossy: z.boolean(), spillPath: remotePath.optional(),
}).strict()
/** Collected stdout/stderr reads for a settled process. */
export const collectedSchema = z.object({ stdout: outputReadSchema.optional(), stderr: outputReadSchema.optional() }).strict()
/** Full process state: pending or final outcome plus collected outputs. */
export const processStateSchema = z.object({ outcome: outcomeSchema.nullable(), collected: collectedSchema }).strict()
/** The helper's startup handshake: protocol version, digest, platform, node facts, and workspace. */
export const helloSchema = z.object({ protocol: z.literal(1), hash: z.string().regex(/^[0-9a-f]{64}$/), platform: z.enum(['linux', 'darwin']), nodeVersion: z.string(), node: remotePath, workspace: remotePath }).strict()
/** Parsed helper handshake. */
export type Hello = z.infer<typeof helloSchema>
