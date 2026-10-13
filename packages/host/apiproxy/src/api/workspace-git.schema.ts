import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceGitCommit, WorkspaceGitCommitFile, WorkspaceGitCommitRef, WorkspaceGitStatusEntry } from './workspace-git.ts'
import { workspaceIdSchema } from './workspace.schema.ts'

const workspaceGitStatusEntrySchema = z.object({
  path: z.string(),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  originalPath: z.string().optional(),
}) satisfies z.ZodType<Wire<WorkspaceGitStatusEntry>>

const workspaceGitCommitRefSchema = z.object({
  kind: z.enum(['head', 'local', 'remote', 'tag', 'other']),
  name: z.string(),
  current: z.boolean(),
}) satisfies z.ZodType<Wire<WorkspaceGitCommitRef>>

const workspaceGitCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]+$/u),
  shortHash: z.string().regex(/^[0-9a-f]+$/u),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  subject: z.string(),
  parents: z.array(z.string().regex(/^[0-9a-f]+$/u)),
  refs: z.array(workspaceGitCommitRefSchema),
}) satisfies z.ZodType<Wire<WorkspaceGitCommit>>

const workspaceGitCommitFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(['A', 'C', 'D', 'M', 'R', 'T']),
}) satisfies z.ZodType<Wire<WorkspaceGitCommitFile>>

const workspaceGitHashSchema = z.string().regex(/^[0-9a-f]{40}$/u)

/** Validate a request to inspect one workspace's Git status. */
export const workspaceGitStatusRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.status'>>>

/** Validate the bounded Git status response for one workspace. */
export const workspaceGitStatusValueSchema = z.object({
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
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

/** Validate a request for one commit's changed paths. */
export const workspaceGitCommitFilesRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  hash: workspaceGitHashSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.commitFiles'>>>

/** Validate the bounded commit file listing response. */
export const workspaceGitCommitFilesValueSchema = z.object({
  files: z.array(workspaceGitCommitFileSchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.commitFiles'>>>

/** Validate a request for one commit's single-path patch. */
export const workspaceGitCommitDiffRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  hash: workspaceGitHashSchema,
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.git.commitDiff'>>>

/** Validate the bounded commit patch response. */
export const workspaceGitCommitDiffValueSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.git.commitDiff'>>>
