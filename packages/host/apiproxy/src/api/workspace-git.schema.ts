import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceGitCommit, WorkspaceGitStatusEntry } from './workspace-git.ts'
import { workspaceIdSchema } from './workspace.schema.ts'

const workspaceGitStatusEntrySchema = z.object({
  path: z.string(),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  originalPath: z.string().optional(),
}) satisfies z.ZodType<Wire<WorkspaceGitStatusEntry>>

const workspaceGitCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]+$/u),
  shortHash: z.string().regex(/^[0-9a-f]+$/u),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  subject: z.string(),
}) satisfies z.ZodType<Wire<WorkspaceGitCommit>>

export const workspaceGitStatusRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.status'>>>

export const workspaceGitStatusValueSchema = z.object({
  branch: z.string().nullable(),
  entries: z.array(workspaceGitStatusEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.status'>>>

export const workspaceGitCommitsRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  limit: z.number().int().min(1).max(100).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.commits'>>>

export const workspaceGitCommitsValueSchema = z.object({
  commits: z.array(workspaceGitCommitSchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.commits'>>>

export const workspaceGitDiffRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().optional(),
  staged: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.diff'>>>

export const workspaceGitDiffValueSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.diff'>>>
