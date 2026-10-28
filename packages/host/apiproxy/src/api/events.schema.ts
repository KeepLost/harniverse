/**
 * events domain zod schemas: MuxFrame / HostFrame unions (discriminatedUnion('type')).
 * A frame is the payload slot of the ServerRequest full form; the SessionEvent inside
 * a session/event frame reuses sessions.schema's strict-envelope + wide-data passthrough branch.
 */

import { z } from 'zod'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  BrowserStreamFrame, EntityStreamOpenPayload, EventsApi, HoldStreamFrame, HostFrame, MuxFrame,
  StreamsFrame, TerminalStreamFrame,
} from './events.ts'
import type { Wire } from './rpc.schema.ts'
import { rpcErrorSchema, rpcIdSchema } from './rpc.schema.ts'
import { approvalRequestIdSchema } from './approvals.schema.ts'
import {
  contentBlockSchema, messageIdSchema, sessionEventSchema, sessionIdSchema, toolEventViewSchema,
} from './sessions.schema.ts'
import { taskViewSchema } from './jobs.schema.ts'
import { workspaceIdSchema, workspaceViewSchema } from './workspace.schema.ts'
import { workspaceFilesWatchRequestSchema } from './workspace-files.schema.ts'

/** events.mux payload, also used to validate the no-envelope query carrier. */
export const eventsMuxRequestSchema = z.object({
  since: z.record(z.string().min(1), z.number().int().min(-1)).optional(),
  page: z.string().regex(/^[\w-]{1,128}$/u).optional(),
}) as z.ZodType<Wire<Parameters<EventsApi['mux']>[0]['payload']>>

/** Page presence declaration: whole-set replacement of a page's open sessions. */
export const eventsAdoptRequestSchema = z.object({
  page: z.string().regex(/^[\w-]{1,128}$/u),
  sessionIds: z.array(sessionIdSchema).max(64),
}) as z.ZodType<Wire<Parameters<EventsApi['adopt']>[0]['payload']>>

/** Adoption is fire-and-forget presence state; the settled value carries nothing. */
export const eventsAdoptValueSchema = z.object({})

/** Question fields validated strictly against core dsh-user-questions. */
export const askUserQuestionItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  // Presentation intent: a tagged union on the wire, so an unknown tag is a
  // rejected frame rather than a silently generic render.
  intent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('plan-review'), approve: z.string() }),
  ]).optional(),
}) satisfies z.ZodType<Wire<AskUserQuestionItem>>

/** Unified message envelope carried by transient queue frames. */
export const messageSchema = z.object({
  id: messageIdSchema,
  role: z.union([z.literal('system'), z.literal('user'), z.literal('assistant')]),
  content: z.array(contentBlockSchema),
  source: z.looseObject({ kind: z.string() }),
})

/** One transient inbox item shared by mux frames and unary status snapshots. */
export const queuedInboxItemSchema = z.object({
  id: messageIdSchema,
  placement: z.union([z.literal('queued'), z.literal('steering'), z.literal('context')]),
  message: messageSchema,
})

/** MuxFrame union (payload slot of a mux-stream ServerRequest). */
export const muxFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session/event'), sessionId: sessionIdSchema, event: sessionEventSchema, view: toolEventViewSchema.optional() }),
  z.object({ type: z.literal('session/subscribed'), sessionId: sessionIdSchema, lastSeq: z.number().int() }),
  z.object({ type: z.literal('approval/requested'), sessionId: sessionIdSchema, approvalId: approvalRequestIdSchema, toolName: z.string(), callId: z.string().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal('approval/resolved'), sessionId: sessionIdSchema, approvalId: approvalRequestIdSchema, outcome: z.union([z.literal('allowed-once'), z.literal('rejected'), z.literal('cancelled'), z.literal('unavailable')]) }),
  // Non-empty by wire contract: the user-questions service rejects empty
  // batches at ask() (EMPTY_QUESTIONS), so an empty frame is host breakage
  // and must fail loud here, not reach the composer.
  z.object({ type: z.literal('question/requested'), sessionId: sessionIdSchema, questions: z.array(askUserQuestionItemSchema).min(1) }),
  z.object({ type: z.literal('question/resolved'), sessionId: sessionIdSchema, questionRpcId: rpcIdSchema, outcome: z.union([z.literal('answered'), z.literal('cancelled')]) }),
  z.object({
    type: z.literal('session/queue'),
    sessionId: sessionIdSchema,
    items: z.array(queuedInboxItemSchema),
  }),
  z.object({ type: z.literal('session/jobs'), sessionId: sessionIdSchema, jobs: z.array(taskViewSchema) }),
  z.object({
    type: z.literal('session/notify'),
    sessionId: sessionIdSchema,
    kind: z.union([z.literal('approval'), z.literal('question'), z.literal('completion'), z.literal('failure'), z.literal('goal-blocked')]),
    sourceKey: z.string().min(1),
    questions: z.array(askUserQuestionItemSchema).min(1).optional(),
  }),
  // value stays wide: it already passed its unit's own schema on the host,
  // and deep-validating here would import every domain's schema into the carrier.
  z.object({ type: z.literal('session/projection'), sessionId: sessionIdSchema, key: z.string().min(1), value: z.unknown(), seq: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('compaction/progress'),
    sessionId: sessionIdSchema,
    compactionId: z.string().min(1),
    phase: z.union([z.literal('reasoning'), z.literal('summary')]),
    text: z.string().min(1),
  }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<MuxFrame>

/** Terminal attachment payload: session identity plus the terminal and its new attachment claim. */
export const eventsTerminalRequestSchema = z.object({
  sessionId: sessionIdSchema,
  id: z.string().regex(/^[\w-]{1,128}$/u),
  attachmentId: z.string().regex(/^[\w-]{1,128}$/u),
}) as unknown as z.ZodType<Wire<Parameters<EventsApi['terminal']>[0]['payload']>>

/** Window-hold payload: session identity plus the retained terminal. */
export const eventsHoldRequestSchema = z.object({
  sessionId: sessionIdSchema,
  id: z.string().regex(/^[\w-]{1,128}$/u),
}) as unknown as z.ZodType<Wire<Parameters<EventsApi['hold']>[0]['payload']>>

/** WebTerminalInfo wire form (shell name/args ride the shell descriptor verbatim). */
const webTerminalInfoSchema = z.object({
  id: z.string().regex(/^[\w-]{1,128}$/u),
  title: z.string(),
  shell: z.object({ path: z.string().min(1), args: z.array(z.string()), name: z.string().min(1) }),
  cwd: z.string().min(1),
  cols: z.number().int().min(2),
  rows: z.number().int().min(1),
  state: z.union([z.literal('running'), z.literal('exited'), z.literal('failed')]),
  exitCode: z.number().int().nullable(),
  error: z.string().optional(),
  controllerId: z.string().regex(/^[\w-]{1,128}$/u).optional(),
})

/** Terminal stream frames (screen recovery, output deltas, metadata, error closer). */
export const terminalStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), sequence: z.number().int().nonnegative(), screen: z.string(), info: webTerminalInfoSchema }),
  z.object({ type: z.literal('output'), sequence: z.number().int().nonnegative(), data: z.string() }),
  z.object({ type: z.literal('state'), info: webTerminalInfoSchema }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<TerminalStreamFrame>

/** Hold stream frames (retention acknowledgement, error closer). */
export const holdStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retained') }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<HoldStreamFrame>

/** Browser attachment payload: session identity plus the page and its new control claim. */
export const eventsBrowserRequestSchema = z.object({
  sessionId: sessionIdSchema,
  id: z.string().regex(/^[\w-]{1,128}$/u),
  attachmentId: z.string().regex(/^[\w-]{1,128}$/u),
}) as unknown as z.ZodType<Wire<Parameters<EventsApi['browser']>[0]['payload']>>

/** HostBrowserPageInfo wire form. */
const hostBrowserPageInfoSchema = z.object({
  id: z.string().regex(/^[\w-]{1,128}$/u),
  url: z.string(),
  title: z.string(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  loading: z.boolean(),
  state: z.union([z.literal('ready'), z.literal('failed'), z.literal('closed')]),
  error: z.string().optional(),
  controllerId: z.string().regex(/^[\w-]{1,128}$/u).optional(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
})

/** One base64 screencast image; the frame carries no data-URL prefix. */
const browserImageFrameSchema = z.object({
  data: z.string(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
})

/** Browser stream frames (page recovery, images, metadata, error closer). */
export const browserStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), info: hostBrowserPageInfoSchema, image: browserImageFrameSchema.optional() }),
  z.object({ type: z.literal('image'), image: browserImageFrameSchema }),
  z.object({ type: z.literal('state'), info: hostBrowserPageInfoSchema }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<BrowserStreamFrame>

/** HostFrame union (payload slot of a host-stream ServerRequest). */
export const hostFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('host/session-added'),
    sessionId: sessionIdSchema,
    blank: z.boolean(),
    parentSessionId: sessionIdSchema.optional(),
    origin: z.literal('subagent').optional(),
    cwd: z.string().optional(),
    agentProfile: z.string().optional(),
  }),
  z.object({ type: z.literal('host/session-removed'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('host/session-status'), sessionId: sessionIdSchema, running: z.boolean() }),
  z.object({ type: z.literal('host/agent-error'), sessionId: sessionIdSchema, message: z.string() }),
  z.object({ type: z.literal('host/workspace-changed'), workspace: workspaceViewSchema }),
  z.object({ type: z.literal('host/workspace-removed'), workspaceId: workspaceIdSchema }),
  z.object({ type: z.literal('host/workspace-order-changed'), workspaceIds: z.array(workspaceIdSchema) }),
  z.object({ type: z.literal('host/archived-sessions-changed'), archivedSessionIds: z.array(sessionIdSchema) }),
  z.object({ type: z.literal('host/pinned-sessions-changed'), pinnedSessionIds: z.array(sessionIdSchema) }),
  // args stays wide, the same posture as session/projection's value: the frame
  // arrives from JSON.parse, so every element is already a JSON value, and the
  // structural contract belongs to the owner package's cordis `Events`
  // declaration — the host validated JSON-safety before forwarding.
  z.object({ type: z.literal('host/remote-event'), event: z.string().min(1), args: z.array(z.unknown()) }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<HostFrame>

/** Substream ids the entity-stream downlink addresses frames by. */
const streamSubIdSchema = z.string().regex(/^[\w-]{1,128}$/u)

/** Page token every substream binds to; one regex, reused by open/close payloads. */
const streamPageSchema = z.string().regex(/^[\w-]{1,128}$/u)

/**
 * Entity-stream downlink frames. The `sub/frame` member leaves its payload
 * wide on purpose: the receiving side validates each frame against the schema
 * of the family that opened the substream (it knows the family from its own
 * open call), exactly like the per-family SSE carrier parses with one schema.
 */
export const streamsFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sub/ready'), sub: streamSubIdSchema }),
  z.object({ type: z.literal('sub/frame'), sub: streamSubIdSchema, frame: z.unknown() }),
  z.object({ type: z.literal('sub/end'), sub: streamSubIdSchema, error: rpcErrorSchema.optional() }),
]) as unknown as z.ZodType<StreamsFrame>

/** Entity-stream downlink open payload: the page token plus one family-tagged binding. */
export const eventsStreamsOpenRequestSchema = z.discriminatedUnion('family', [
  z.object({ page: streamPageSchema, family: z.literal('terminal'), payload: eventsTerminalRequestSchema }),
  z.object({ page: streamPageSchema, family: z.literal('hold'), payload: eventsHoldRequestSchema }),
  z.object({ page: streamPageSchema, family: z.literal('browser'), payload: eventsBrowserRequestSchema }),
  z.object({ page: streamPageSchema, family: z.literal('files-watch'), payload: workspaceFilesWatchRequestSchema }),
]) as z.ZodType<Wire<EntityStreamOpenPayload & { page: string }>>

/** The open response addresses the new substream. */
export const eventsStreamsOpenValueSchema = z.object({ sub: streamSubIdSchema })

/** Closing is idempotent; the settled value carries nothing. */
export const eventsStreamsCloseRequestSchema = z.object({
  page: streamPageSchema,
  sub: streamSubIdSchema,
})

/** Closing is fire-and-forget teardown; the settled value carries nothing. */
export const eventsStreamsCloseValueSchema = z.object({})
