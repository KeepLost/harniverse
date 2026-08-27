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

export const workspaceFilesListRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.files.list'>>>

export const workspaceFilesListValueSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceFileEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.files.list'>>>

export const workspaceFilesReadRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.files.read'>>>

export const workspaceFilesReadValueSchema = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.files.read'>>>
