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

/** Validate a request to inspect one workspace's Git status. */
export const workspaceGitStatusRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.status'>>>

/** Validate the bounded Git status response for one workspace. */
export const workspaceGitStatusValueSchema = z.object({
  branch: z.string().nullable(),
  entries: z.array(workspaceGitStatusEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.status'>>>

/** Validate a request for bounded Git history in one workspace. */
export const workspaceGitCommitsRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  limit: z.number().int().min(1).max(100).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.commits'>>>

/** Validate the bounded Git history response. */
export const workspaceGitCommitsValueSchema = z.object({
  commits: z.array(workspaceGitCommitSchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.commits'>>>

/** Validate a request for a workspace-relative Git diff. */
export const workspaceGitDiffRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().optional(),
  staged: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.diff'>>>

/** Validate the bounded Git diff response. */
export const workspaceGitDiffValueSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.diff'>>>
