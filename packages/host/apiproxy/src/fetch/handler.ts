/**
 * Server side of the fetch carrier: maps an ApiProxy onto a pure
 * WHATWG Request->Response function. Two-level parse: full form (type/rpcId/method +
 * path==method) -> payload dispatched per method. HTTP status expresses only the carrier
 * (404 unknown path / 415 non-JSON media type / 400 non-JSON body / 500 handler crash);
 * business errors are always 200 + ServerResponse.
 */

import { randomUUID } from 'node:crypto'
import {
  authenticationPrincipalIdentity, sameAuthenticationPrincipal,
  type AuthenticationPrincipal, type AuthenticationPrincipalIdentity,
} from '@deepseek-ai/dsh-authentication'
import type { z } from 'zod'
import type { ApiProxy, MuxFrame, HostFrame } from '../api/index.ts'
import { sessionLogQuerySchema } from '../api/downloads.schema.ts'
import { isMutatingRpcMethod, type RequestPayload, type ResponseValue, type RpcMethodMap } from '../api/rpc-map.ts'
import type { ClientRequest, RpcError, RpcRequest, RpcResponse, ServerRequest, ServerResponse } from '../api/rpc.ts'
import { CONNECTION_AUTHENTICATED_METHOD, RequestId, RpcId } from '../api/rpc.ts'
import type { Wire } from '../api/rpc.schema.ts'
import { clientRequestSchema, clientResponseSchema, serverResponseSchema } from '../api/rpc.schema.ts'
import {
  sessionCancelRequestSchema,
  sessionAttachmentRequestSchema,
  sessionCloseRequestSchema,
  sessionDeleteRequestSchema,
  sessionCreateRequestSchema,
  sessionForkRequestSchema,
  sessionHistoryRequestSchema,
  sessionListRequestSchema,
  sessionModelsRequestSchema,
  sessionPromptRequestSchema,
  sessionRenameRequestSchema,
  sessionSearchRequestSchema,
  sessionSelectModelRequestSchema,
  sessionSelectModelTargetRequestSchema,
  sessionSelectModelProfileRequestSchema,
  sessionUpdateQueueRequestSchema,
  sessionWorkStatusRequestSchema,
} from '../api/sessions.schema.ts'
import { sessionStatusRequestSchema } from '../api/session-status.schema.ts'
import {
  hostCreateDirectoryRequestSchema, hostDescribeRequestSchema,
  hostListDirectoryRequestSchema, hostOpenPathRequestSchema,
  hostPickDirectoryRequestSchema,
} from '../api/host.schema.ts'
import {
  workspaceArchiveSessionRequestSchema,
  workspaceCreateRequestSchema,
  workspaceDeleteRequestSchema,
  workspaceInsertBeforeRequestSchema,
  workspaceInsertSessionBeforeRequestSchema,
  workspaceListRequestSchema,
  workspaceRenameRequestSchema,
  workspaceUnarchiveSessionRequestSchema,
} from '../api/workspace.schema.ts'
import { skillListRequestSchema } from '../api/skills.schema.ts'
import {
  agentPresetCopyRequestSchema, agentPresetListRequestSchema, agentPresetOpenDocumentRequestSchema,
  agentPresetReadRequestSchema, agentPresetRemoveRequestSchema,
} from '../api/agent-presets.schema.ts'
import {
  goalCreateRequestSchema,
  goalEditRequestSchema,
  goalPauseRequestSchema,
  goalResumeRequestSchema,
  goalCompleteRequestSchema,
  goalClearRequestSchema,
} from '../api/goals.schema.ts'
import {
  settingsDescribeRequestSchema, settingsMutateRequestSchema, settingsOpenDocumentRequestSchema,
  settingsReplaceRequestSchema, settingsUpdateRequestSchema,
} from '../api/settings.schema.ts'
import {
  credentialsDescribeRequestSchema, credentialsSetRequestSchema, credentialsUnsetRequestSchema,
} from '../api/credentials.schema.ts'
import { llmDiscoverModelsRequestSchema, llmModelsRequestSchema, llmProvidersRequestSchema } from '../api/llm.schema.ts'
import {
  subagentHistoryRequestSchema,
  subagentInterruptRequestSchema,
  subagentListRequestSchema,
  subagentPromptRequestSchema,
  subagentProfilesRequestSchema,
} from '../api/subagents.schema.ts'
import { eventsMuxRequestSchema } from '../api/events.schema.ts'
import { apiDescribeRequestSchema } from '../api/contract.schema.ts'
import { operationGetRequestSchema } from '../api/operations.schema.ts'
import {
  workspaceFilesListRequestSchema, workspaceFilesReadBinaryRequestSchema,
  workspaceFilesReadRequestSchema, workspaceFilesSearchRequestSchema,
} from '../api/workspace-files.schema.ts'
import {
  workspaceGitCommitsRequestSchema, workspaceGitDiffRequestSchema, workspaceGitStatusRequestSchema,
} from '../api/workspace-git.schema.ts'

/**
 * Unary dispatch table, keyed by (and compiler-locked to) RpcMethodMap: a map row without a
 * route row fails to compile, and each row's schema/invoke pair is checked against that row's
 * payload type — a schema pasted onto the wrong row is a type error, not a runtime surprise.
 * Schemas anchor to the Wire<> widening (the repo-wide exactOptionalPropertyTypes accommodation
 * documented on Wire); the dispatch point carries the one Wire→exact cast.
 * Every invoke receives the carrier Request's signal; routes whose contract
 * declares a signal parameter forward it, and the rest ignore it.
 */
type UnaryRoutes = {
  [K in keyof RpcMethodMap]: {
    schema: z.ZodType<Wire<RequestPayload<K>>>
    invoke(api: ApiProxy, request: RpcRequest<RequestPayload<K>>, signal: AbortSignal): Promise<RpcResponse<ResponseValue<K>>>
  }
}

type ApiProxyFailureReporter = (operation: string, error: unknown) => void

interface IdempotencyEntry {
  fingerprint: string
  expiresAt: number
  response: Promise<ServerResponse | undefined>
}

const IDEMPOTENCY_STORES = new WeakMap<ApiProxy, Map<string, IdempotencyEntry>>()

const UNARY_ROUTES: UnaryRoutes = {
  'api.describe': { schema: apiDescribeRequestSchema, invoke: (api, r) => api.api?.describe(r) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'API contract discovery is unavailable', details: {} } } }) },
  'operation.get': { schema: operationGetRequestSchema, invoke: (api, r) => api.operations?.get(r) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'operation lookup is unavailable', details: {} } } }) },
  'session.list': { schema: sessionListRequestSchema, invoke: (api, r) => api.sessions.list(r) },
  'session.search': { schema: sessionSearchRequestSchema, invoke: (api, r, signal) => api.sessions.search(r, signal) },
  'session.create': { schema: sessionCreateRequestSchema, invoke: (api, r) => api.sessions.create(r) },
  'session.history': { schema: sessionHistoryRequestSchema, invoke: (api, r, signal) => api.sessions.history(r, signal) },
  'session.status': { schema: sessionStatusRequestSchema, invoke: (api, r) => api.sessions.status(r) },
  'session.workStatus': { schema: sessionWorkStatusRequestSchema, invoke: (api, r) => api.sessions.workStatus(r) },
  'session.models': { schema: sessionModelsRequestSchema, invoke: (api, r) => api.sessions.models(r) },
  'session.selectModel': { schema: sessionSelectModelRequestSchema, invoke: (api, r) => api.sessions.selectModel(r) },
  'session.selectModelTarget': { schema: sessionSelectModelTargetRequestSchema, invoke: (api, r) => api.sessions.selectModelTarget?.(r) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'model target selection is unavailable', details: {} } } }) },
  'session.selectModelProfile': { schema: sessionSelectModelProfileRequestSchema, invoke: (api, r) => api.sessions.selectModelProfile?.(r) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'model profile selection is unavailable', details: {} } } }) },
  'session.rename': { schema: sessionRenameRequestSchema, invoke: (api, r) => api.sessions.rename(r) },
  'session.fork': { schema: sessionForkRequestSchema, invoke: (api, r) => api.sessions.fork(r) },
  'session.prompt': { schema: sessionPromptRequestSchema, invoke: (api, r) => api.sessions.prompt(r) },
  'session.attachment': { schema: sessionAttachmentRequestSchema, invoke: (api, r) => api.sessions.attachment(r) },
  'session.updateQueue': { schema: sessionUpdateQueueRequestSchema, invoke: (api, r) => api.sessions.updateQueue(r) },
  'session.cancel': { schema: sessionCancelRequestSchema, invoke: (api, r) => api.sessions.cancel(r) },
  'session.close': { schema: sessionCloseRequestSchema, invoke: (api, r) => api.sessions.close(r) },
  'session.delete': { schema: sessionDeleteRequestSchema, invoke: (api, r) => api.sessions.delete(r) },
  'subagent.list': { schema: subagentListRequestSchema, invoke: (api, r, signal) => api.subagents.list(r, signal) },
  'subagent.profiles': { schema: subagentProfilesRequestSchema, invoke: (api, r) => api.subagents.profiles(r) },
  'subagent.history': { schema: subagentHistoryRequestSchema, invoke: (api, r, signal) => api.subagents.history(r, signal) },
  'subagent.prompt': { schema: subagentPromptRequestSchema, invoke: (api, r, signal) => api.subagents.prompt(r, signal) },
  'subagent.interrupt': { schema: subagentInterruptRequestSchema, invoke: (api, r) => api.subagents.interrupt(r) },
  'host.describe': { schema: hostDescribeRequestSchema, invoke: (api, r) => api.host.describe(r) },
  'host.pickDirectory': { schema: hostPickDirectoryRequestSchema, invoke: (api, r, signal) => api.host.pickDirectory(r, signal) },
  'host.listDirectory': { schema: hostListDirectoryRequestSchema, invoke: (api, r, signal) => api.host.listDirectory(r, signal) },
  'host.createDirectory': { schema: hostCreateDirectoryRequestSchema, invoke: (api, r) => api.host.createDirectory(r) },
  'host.openPath': { schema: hostOpenPathRequestSchema, invoke: (api, r, signal) => api.host.openPath(r, signal) },
  'workspace.list': { schema: workspaceListRequestSchema, invoke: (api, r) => api.workspace.list(r) },
  'workspace.create': { schema: workspaceCreateRequestSchema, invoke: (api, r) => api.workspace.create(r) },
  'workspace.rename': { schema: workspaceRenameRequestSchema, invoke: (api, r) => api.workspace.rename(r) },
  'workspace.delete': { schema: workspaceDeleteRequestSchema, invoke: (api, r) => api.workspace.delete(r) },
  'workspace.insertBefore': { schema: workspaceInsertBeforeRequestSchema, invoke: (api, r) => api.workspace.insertBefore(r) },
  'workspace.insertSessionBefore': { schema: workspaceInsertSessionBeforeRequestSchema, invoke: (api, r) => api.workspace.insertSessionBefore(r) },
  'workspace.archiveSession': { schema: workspaceArchiveSessionRequestSchema, invoke: (api, r) => api.workspace.archiveSession(r) },
  'workspace.unarchiveSession': { schema: workspaceUnarchiveSessionRequestSchema, invoke: (api, r) => api.workspace.unarchiveSession(r) },
  'workspace.files.list': { schema: workspaceFilesListRequestSchema, invoke: (api, r, signal) => api.workspaceFiles?.list(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace file inspection is unavailable', details: {} } } }) },
  'workspace.files.search': { schema: workspaceFilesSearchRequestSchema, invoke: (api, r, signal) => api.workspaceFiles?.search(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace file inspection is unavailable', details: {} } } }) },
  'workspace.files.read': { schema: workspaceFilesReadRequestSchema, invoke: (api, r, signal) => api.workspaceFiles?.read(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace file inspection is unavailable', details: {} } } }) },
  'workspace.files.readBinary': { schema: workspaceFilesReadBinaryRequestSchema, invoke: (api, r, signal) => api.workspaceFiles?.readBinary(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace file inspection is unavailable', details: {} } } }) },
  'workspace.git.status': { schema: workspaceGitStatusRequestSchema, invoke: (api, r, signal) => api.workspaceGit?.status(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace Git inspection is unavailable', details: {} } } }) },
  'workspace.git.commits': { schema: workspaceGitCommitsRequestSchema, invoke: (api, r, signal) => api.workspaceGit?.commits(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace Git inspection is unavailable', details: {} } } }) },
  'workspace.git.diff': { schema: workspaceGitDiffRequestSchema, invoke: (api, r, signal) => api.workspaceGit?.diff(r, signal) ?? Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'internal', message: 'workspace Git inspection is unavailable', details: {} } } }) },
  'skill.list': { schema: skillListRequestSchema, invoke: (api, r) => api.skills.list(r) },
  'agentPreset.list': { schema: agentPresetListRequestSchema, invoke: (api, r) => api.agentPresets.list(r) },
  'agentPreset.read': { schema: agentPresetReadRequestSchema, invoke: (api, r) => api.agentPresets.read(r) },
  'agentPreset.copy': { schema: agentPresetCopyRequestSchema, invoke: (api, r) => api.agentPresets.copy(r) },
  'agentPreset.openDocument': { schema: agentPresetOpenDocumentRequestSchema, invoke: (api, r, signal) => api.agentPresets.openDocument(r, signal) },
  'agentPreset.remove': { schema: agentPresetRemoveRequestSchema, invoke: (api, r) => api.agentPresets.remove(r) },
  'goal.create': { schema: goalCreateRequestSchema, invoke: (api, r) => api.goals.create(r) },
  'goal.edit': { schema: goalEditRequestSchema, invoke: (api, r) => api.goals.edit(r) },
  'goal.pause': { schema: goalPauseRequestSchema, invoke: (api, r) => api.goals.pause(r) },
  'goal.resume': { schema: goalResumeRequestSchema, invoke: (api, r) => api.goals.resume(r) },
  'goal.complete': { schema: goalCompleteRequestSchema, invoke: (api, r) => api.goals.complete(r) },
  'goal.clear': { schema: goalClearRequestSchema, invoke: (api, r) => api.goals.clear(r) },
  'settings.describe': { schema: settingsDescribeRequestSchema, invoke: (api, r) => api.settings.describe(r) },
  'settings.openDocument': { schema: settingsOpenDocumentRequestSchema, invoke: (api, r, signal) => api.settings.openDocument(r, signal) },
  'settings.update': { schema: settingsUpdateRequestSchema, invoke: (api, r) => api.settings.update(r) },
  'settings.replace': { schema: settingsReplaceRequestSchema, invoke: (api, r) => api.settings.replace(r) },
  'settings.mutate': { schema: settingsMutateRequestSchema, invoke: (api, r) => api.settings.mutate(r) },
  'credentials.describe': { schema: credentialsDescribeRequestSchema, invoke: (api, r) => api.credentials.describe(r) },
  'credentials.set': { schema: credentialsSetRequestSchema, invoke: (api, r) => api.credentials.set(r) },
  'credentials.unset': { schema: credentialsUnsetRequestSchema, invoke: (api, r) => api.credentials.unset(r) },
  'llm.providers': { schema: llmProvidersRequestSchema, invoke: (api, r) => api.llm.providers(r) },
  'llm.models': { schema: llmModelsRequestSchema, invoke: (api, r) => api.llm.models(r) },
  'llm.discoverModels': { schema: llmDiscoverModelsRequestSchema, invoke: (api, r, signal) => api.llm.discoverModels(r, signal) },
}

/** Route lookup that narrows an arbitrary path segment to a map key (single cast point for the string→key refinement). */
function methodFor(path: string): keyof RpcMethodMap | undefined {
  return Object.hasOwn(UNARY_ROUTES, path) ? path as keyof RpcMethodMap : undefined
}

/**
 * Sentinel rpcId for error responses to envelopes whose own rpcId is unreadable: the response
 * must still be a valid ServerResponse (a self-violating shape would turn the server's explicit
 * bad-request report into a client-side parse failure). Fixed value, documented here as wire contract.
 */
const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')

/** Host-authenticated identity for one carrier admission; local injection runs as bypass. */
function carrierIdentity(principal?: AuthenticationPrincipal): AuthenticationPrincipalIdentity {
  return principal === undefined ? { kind: 'bypass' } : authenticationPrincipalIdentity(principal)
}

/** Wrap a business error as a ServerResponse full form (rpcId backfilled; an unreadable rpcId uses the invalid-request sentinel). */
function errorResponse(
  rpcId: RpcId,
  error: RpcError,
  principal?: AuthenticationPrincipal,
  requestId?: RequestId,
): Response {
  const body: ServerResponse = {
    type: 'server-response', rpcId, result: { ok: false, error },
    authentication: carrierIdentity(principal),
    ...(requestId === undefined ? {} : { requestId }),
  }
  return Response.json(body)
}

/** Complete the impl's narrow form into a ServerResponse full form. */
function fullResponse(
  narrow: RpcResponse<unknown>,
  principal?: AuthenticationPrincipal,
  requestId?: RequestId,
): Response {
  const body: ServerResponse = {
    type: 'server-response', rpcId: narrow.rpcId, result: narrow.result,
    authentication: carrierIdentity(principal),
    ...(requestId === undefined ? {} : { requestId }),
  }
  return Response.json(body)
}

/**
 * Parse the payload and invoke one unary route. Generic over the map key so
 * the row's schema/invoke pairing typechecks; the only cast collapses the
 * Wire<> widening back to the exact payload (undefined-valued properties and
 * absent ones are indistinguishable after JSON transport).
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- K keeps each route's schema and invoke types paired.
async function handleUnary<K extends keyof RpcMethodMap>(
  api: ApiProxy,
  method: K,
  message: ClientRequest,
  signal: AbortSignal,
  principal?: AuthenticationPrincipal,
  reportFailure?: ApiProxyFailureReporter,
): Promise<Response> {
  const route = UNARY_ROUTES[method]
  const payload = route.schema.safeParse(message.payload)
  if (!payload.success) {
    return errorResponse(message.rpcId, { code: 'bad-request', message: `invalid payload for ${method}`, details: { issues: payload.error.issues } }, principal, message.requestId)
  }
  try {
    return fullResponse(await route.invoke(api, {
      rpcId: message.rpcId,
      payload: payload.data,
      ...(principal !== undefined && { principal }),
    }, signal), principal, message.requestId)
  } catch (error: unknown) {
    reportFailure?.(method, error)
    return new Response('internal handler failure', { status: 500 })
  }
}

/** SSE frame: complete the narrow RpcRequest<frame> into a ServerRequest full form (method = frame type). */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return { type: 'server-request', rpcId: narrow.rpcId, method: narrow.payload.type, payload: narrow.payload }
}

/**
 * Wrap a frame stream as an SSE Response; stops when req.signal aborts. An
 * impl throw mid-stream emits one stream/error frame and then closes.
 */
function sseResponse(
  frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
  operation: string,
  principal?: AuthenticationPrincipal,
  reportFailure?: ApiProxyFailureReporter,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Send an SSE comment line on open so clients/proxies see a live channel (the host
        // stream has no baseline frames and would otherwise emit zero bytes while idle;
        // a comment line is not a frame, so client frame parsing skips it naturally).
        controller.enqueue(encoder.encode(': connected\n\n'))
        const authenticated: ServerRequest = {
          type: 'server-request',
          rpcId: RpcId(randomUUID()),
          method: CONNECTION_AUTHENTICATED_METHOD,
          payload: carrierIdentity(principal),
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(authenticated)}\n\n`))
        for await (const narrow of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fullFrame(narrow))}\n\n`))
        }
      } catch (error: unknown) {
        // Mid-stream impl failure → one stream/error frame, then close: the client must see
        // the failure instead of a silent end (which reads as a normal disconnect). A fresh
        // rpcId is minted — this is a server-initiated push like any other frame.
        reportFailure?.(operation, error)
        const failure: MuxFrame | HostFrame = {
          type: 'stream/error',
          error: { code: 'internal', message: 'event stream failed', details: {} },
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fullFrame({ rpcId: RpcId(randomUUID()), payload: failure }))}\n\n`))
        } catch {
          // Consumer already cancelled the stream: enqueue-after-cancel is the
          // only reachable error, and there is no one left to tell.
        }
      } finally {
        try {
          controller.close()
        } catch { /* already cancelled by the consumer: a double close is the only reachable error */ }
      }
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

/**
 * Wraps an ApiProxy into a pure fetch function (isomorphic point: feed the returned fetch straight to InProcessApiClient).
 * @param api - the host-side ApiProxy implementation.
 * @param principal - authenticated network identity attached to host-side requests.
 * @param reportFailure - optional server-side unexpected-failure reporter.
 * @returns an object holding `fetch(Request)`; paths outside /api/ return 404.
 */
export function toFetchHandler(
  api: ApiProxy,
  principal?: AuthenticationPrincipal,
  reportFailure?: ApiProxyFailureReporter,
): { fetch: typeof fetch } {
  const idempotency = IDEMPOTENCY_STORES.get(api) ?? new Map<string, IdempotencyEntry>()
  IDEMPOTENCY_STORES.set(api, idempotency)
  const idempotencyTtlMs = 24 * 60 * 60 * 1000
  const maxIdempotencyEntries = 1024

  function idempotencyScope(principal: AuthenticationPrincipal | undefined, method: string, key: string): string {
    const identity = principal === undefined ? 'bypass' : JSON.stringify(authenticationPrincipalIdentity(principal))
    return `${identity}\u0000${method}\u0000${key}`
  }

  function purgeExpiredIdempotency(now: number): void {
    for (const [scope, entry] of idempotency) {
      if (entry.expiresAt <= now) idempotency.delete(scope)
    }
  }

  function makeRoomForIdempotency(): void {
    // Insertion order is eviction order; the loop only runs while the ledger is
    // full, so it always has a key to drop.
    for (const oldest of idempotency.keys()) {
      if (idempotency.size < maxIdempotencyEntries) return
      idempotency.delete(oldest)
    }
  }

  function replayResponse(body: ServerResponse, message: ClientRequest): Response {
    return Response.json({
      ...body,
      rpcId: message.rpcId,
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
    })
  }

  return {
    // Signature matches global fetch: the isomorphic point hands this function to InProcessApiClient as its transport aspect,
    // Clients call in (url, init) form — normalize to Request before handling.
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input, init)
      const url = new URL(req.url)
      const path = url.pathname

      // No-envelope read channels (SSE GET streams + host-only download):
      // physical routes that answer directly, without a wire envelope.
      if (path === '/api/events.mux' && req.method === 'GET') {
        const values = url.searchParams.getAll('since')
        let decoded: unknown = undefined
        try {
          if (values.length > 1) throw new Error('duplicate since')
          if (values[0] !== undefined) decoded = JSON.parse(values[0])
        } catch {
          return new Response('invalid since query parameter', { status: 400 })
        }
        const parsed = eventsMuxRequestSchema.safeParse(decoded === undefined ? {} : { since: decoded })
        if (!parsed.success) return new Response('invalid since query parameter', { status: 400 })
        // JSON has no undefined-valued record entries; collapse Wire<> to the
        // exact payload after the schema has validated every key and value.
        const payload = parsed.data as Parameters<ApiProxy['events']['mux']>[0]['payload']
        return sseResponse(api.events.mux({
          rpcId: RpcId(randomUUID()),
          payload,
          ...(principal !== undefined && { principal }),
        }, req.signal), 'events.mux', principal, reportFailure)
      }
      if (path === '/api/events.host' && req.method === 'GET') {
        return sseResponse(api.events.host({
          rpcId: RpcId(randomUUID()),
          payload: {},
          ...(principal !== undefined && { principal }),
        }, req.signal), 'events.host', principal, reportFailure)
      }
      if (path === '/api/session.export' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Query params are a different boundary from the POST envelope, but
        // the request still casts its brands only through the domain schema.
        const parsed = sessionLogQuerySchema.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
          return new Response('missing or invalid sessionId query parameter', { status: 400 })
        }
        const response = await api.downloads.sessionLog(parsed.data, req.signal)
        if (req.method === 'GET') return response
        await response.body?.cancel()
        return new Response(null, { status: response.status, headers: response.headers })
      }

      if (req.method !== 'POST' || !path.startsWith('/api/')) {
        return new Response('not found', { status: 404 })
      }

      // Cross-site write fence: browsers send "simple" POSTs (text/plain,
      // form encodings) without a CORS preflight, so a malicious page could
      // otherwise execute side-effectful RPCs blind — the response stays
      // unreadable cross-origin, but session.prompt would still run. Only the
      // JSON media type is accepted; anything else is forced into a preflight
      // this server never answers. 415 = carrier layer, like the 400 below.
      const mediaType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        // 400 = carrier layer (body is not even JSON); valid JSON with a bad shape goes 200 + bad-request.
        return new Response('body is not JSON', { status: 400 })
      }

      if (path === '/api/respond') {
        const parsed = clientResponseSchema.safeParse(body)
        if (!parsed.success) return Response.json({
          accepted: false, reason: 'bad-response', authentication: carrierIdentity(principal),
        })
        if (principal !== undefined
          && !sameAuthenticationPrincipal(parsed.data.expectedPrincipal, authenticationPrincipalIdentity(principal))) {
          return Response.json({
            accepted: false,
            reason: 'authentication-principal-mismatch',
            authentication: carrierIdentity(principal),
          })
        }
        return Response.json({ ...await api.respond(parsed.data), authentication: carrierIdentity(principal) })
      }

      const method = methodFor(path.slice('/api/'.length))
      if (method === undefined) return new Response('not found', { status: 404 })

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        // Best effort at correlation: salvage a string rpcId from the raw body;
        // otherwise the fixed sentinel keeps the response a valid ServerResponse.
        const rawId = (body as { rpcId?: unknown } | null)?.rpcId
        const rawRequestId = (body as { requestId?: unknown } | null)?.requestId
        const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
        const requestId = typeof rawRequestId === 'string' ? RequestId(rawRequestId) : undefined
        return errorResponse(rpcId, { code: 'bad-request', message: 'invalid client-request message', details: { issues: envelope.error.issues } }, principal, requestId)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== method) {
        return errorResponse(message.rpcId, { code: 'bad-request', message: `method "${message.method}" does not match path "${method}"`, details: { issues: [] } }, principal, message.requestId)
      }
      if (principal !== undefined && isMutatingRpcMethod(method)
        && !sameAuthenticationPrincipal(message.expectedPrincipal, authenticationPrincipalIdentity(principal))) {
        return errorResponse(message.rpcId, {
          code: 'authentication-principal-mismatch',
          message: 'authenticated principal changed before mutation dispatch',
          details: {},
        }, principal, message.requestId)
      }
      const idempotencyKey = req.headers.get('idempotency-key')?.trim()
      if (isMutatingRpcMethod(method) && idempotencyKey !== undefined && idempotencyKey !== '') {
        const now = Date.now()
        purgeExpiredIdempotency(now)
        const scope = idempotencyScope(principal, method, idempotencyKey)
        const fingerprint = JSON.stringify(message.payload)
        const existing = idempotency.get(scope)
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return errorResponse(message.rpcId, {
              code: 'idempotency-key-reused',
              message: 'Idempotency-Key was already used with a different payload',
              details: { key: idempotencyKey },
            }, principal, message.requestId)
          }
          const cached = await existing.response
          return cached === undefined
            ? handleUnary(api, method, message, req.signal, principal, reportFailure)
            : replayResponse(cached, message)
        }
        const response = handleUnary(api, method, message, req.signal, principal, reportFailure)
        const cachedResponse = response.then(async (result) => {
          if (result.status !== 200) return undefined
          return serverResponseSchema.parse(await result.clone().json())
        })
        makeRoomForIdempotency()
        idempotency.set(scope, { fingerprint, expiresAt: now + idempotencyTtlMs, response: cachedResponse })
        const body = await cachedResponse
        return body === undefined ? response : replayResponse(body, message)
      }
      return handleUnary(api, method, message, req.signal, principal, reportFailure)
    },
  }
}
