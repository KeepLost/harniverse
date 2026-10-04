import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceFileEntry, WorkspaceFileWatchFrame } from './workspace-files.ts'
import type { WorkspaceFilesApi } from './workspace-files.ts'
import { WORKSPACE_GLOB_LIST_LIMIT, WORKSPACE_GLOB_PATTERN_LIMIT } from './workspace-files.ts'
import { rpcErrorSchema } from './rpc.schema.ts'
import { workspaceIdSchema } from './workspace.schema.ts'

const workspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.union([z.literal('file'), z.literal('directory'), z.literal('symlink'), z.literal('other')]),
}) satisfies z.ZodType<Wire<WorkspaceFileEntry>>

/** Wire validator for one directory-list request. */
export const workspaceFilesListRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.files.list'>>>

/** Wire validator for one directory-list result. */
export const workspaceFilesListValueSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceFileEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.files.list'>>>

/**
 * One glob list: bounded in both length and per-pattern size so a pattern list
 * cannot become an unbounded compilation input.
 */
const workspaceGlobListSchema = z.array(
  z.string().trim().min(1).max(WORKSPACE_GLOB_PATTERN_LIMIT),
).max(WORKSPACE_GLOB_LIST_LIMIT)

/** Wire validator for one bounded file-name search request. */
export const workspaceFilesSearchRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  query: z.string().trim().min(1).max(200),
  include: workspaceGlobListSchema.optional(),
  exclude: workspaceGlobListSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.files.search'>>>

/** Wire validator for one bounded file-name search result. */
export const workspaceFilesSearchValueSchema = z.object({
  entries: z.array(workspaceFileEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.files.search'>>>

/** Wire validator for one UTF-8 file-read request. */
export const workspaceFilesReadRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.files.read'>>>

/** Wire validator for one UTF-8 file-read result. */
export const workspaceFilesReadValueSchema = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.files.read'>>>

/** Wire validator for one bounded binary-preview request. */
export const workspaceFilesReadBinaryRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.files.readBinary'>>>

/** Wire validator for one bounded binary-preview result. */
export const workspaceFilesReadBinaryValueSchema = z.object({
  path: z.string(),
  dataBase64: z.string(),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.files.readBinary'>>>

/**
 * Wire validator for one file-watch stream open (the no-envelope GET query
 * carrier): a registered workspace id plus an optional workspace-relative
 * target whose omission addresses the workspace root.
 */
export const workspaceFilesWatchRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<Parameters<WorkspaceFilesApi['watchFiles']>[0]['payload']>>

/**
 * Wire validator for one file-watch stream frame (the SSE payload envelope's
 * inner value): `ready`/`change` are kind-discriminated contract payloads,
 * and the shared `stream/error` member closes a failed stream.
 */
export const workspaceFilesWatchFrameSchema = z.union([
  z.object({ kind: z.literal('ready') }),
  z.object({
    kind: z.literal('change'),
    change: z.union([
      z.object({ absolutePath: z.string(), version: z.string() }),
      z.object({ absolutePath: z.string(), absent: z.literal(true) }),
    ]),
  }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<WorkspaceFileWatchFrame>
