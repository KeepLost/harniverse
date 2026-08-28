import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceFileEntry } from './workspace-files.ts'
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

/** Wire validator for one bounded file-name search request. */
export const workspaceFilesSearchRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  query: z.string().trim().min(1).max(200),
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
