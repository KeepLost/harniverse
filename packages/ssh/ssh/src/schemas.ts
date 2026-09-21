/** Strict validation at the trusted machine's private RPC boundary. */
import { z } from 'zod'

export const remotePath = z.string().startsWith('/').refine(value => !value.includes('\0'))
export const targetSchema = z.object({ targetKey: remotePath, displayPath: z.string() }).strict()
export const infoSchema = z.object({ version: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.number().nonnegative().optional() }).strict()
export const pathInfoSchema = infoSchema.extend({ type: z.enum(['file', 'directory', 'symlink', 'other']) })
export const policySchema = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']), workspaceRoot: remotePath, sessionId: z.string().optional() }).strict()
export const entriesSchema = z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']), target: targetSchema, version: z.string().optional(), size: z.number().nonnegative().optional() }).strict())
export const intentSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(), z.object({ kind: z.literal('replaceIfVersion'), version: z.string() }).strict()])
export const editSchema = z.object({ oldString: z.string(), newString: z.string(), replaceAll: z.boolean() }).strict()
export const writeResultSchema = z.object({ operation: z.enum(['create', 'update']), version: z.string(), before: z.string().nullable(), after: z.string() }).strict()
export const editResultSchema = z.object({ version: z.string(), before: z.string(), after: z.string() }).strict()
export const environmentSchema = z.record(z.string(), z.string().nullable())
const collection = z.object({
  maxBytes: z.number().int().positive().max(1024 * 1024),
  spill: z.object({ maxBytes: z.number().int().positive() }).strict().optional(),
}).strict()
export const spawnSchema = z.object({
  argv: z.array(z.string().refine(value => !value.includes('\0'))).min(1), cwd: remotePath,
  env: environmentSchema.optional(), graceMs: z.number().int().positive().max(30_000),
  limits: z.object({ maxMemoryBytes: z.number().int().positive().optional() }).strict().optional(),
  stdio: z.object({
    stdin: z.union([z.literal('ignore'), z.literal('pipe'), z.object({ data: z.string() }).strict()]),
    stdout: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
    stderr: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
  }).strict().optional(),
  terminal: z.object({ rows: z.number().int().positive(), cols: z.number().int().positive() }).strict().optional(),
}).strict().refine(value => (value.stdio === undefined) !== (value.terminal === undefined), 'select ordinary or terminal execution')
export const processIdSchema = z.uuid()
export const outcomeSchema = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict()
export const foregroundSchema = z.object({ processGroupId: z.number().int().positive(), inputWaiting: z.boolean() }).strict().nullable()
export const outputReadSchema = z.object({
  text: z.string(), nextOffset: z.number().int().nonnegative(), lossy: z.boolean(), spillPath: remotePath.optional(),
}).strict()
export const collectedSchema = z.object({ stdout: outputReadSchema.optional(), stderr: outputReadSchema.optional() }).strict()
export const processStateSchema = z.object({ outcome: outcomeSchema.nullable(), collected: collectedSchema }).strict()
export const helloSchema = z.object({ protocol: z.literal(1), hash: z.string().regex(/^[0-9a-f]{64}$/), platform: z.enum(['linux', 'darwin']), nodeVersion: z.string(), node: remotePath, workspace: remotePath }).strict()
export type Hello = z.infer<typeof helloSchema>
