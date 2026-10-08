/**
 * The closed endpoint table of the chat bridge. Only the methods listed here
 * can reach `/api`; every other method, Typert endpoint, and path is refused
 * locally. Each row carries the response-value schema the bridge reads, so a
 * drifted wire shape fails at the client boundary.
 * @module @deepseek-ai/dsh-chat-harniverse-client/endpoints
 */

import { z } from 'zod'

const messageState = z.looseObject({ state: z.string() })

/** Unary `/api/<method>` rows: whether the method mutates state, and its response-value schema. */
export const UNARY_ENDPOINTS = {
  'api.describe': { mutating: false, value: z.looseObject({ version: z.number(), methods: z.array(z.looseObject({ method: z.string(), requiredCapability: z.string(), effect: z.string() })) }) },
  'host.describe': { mutating: false, value: z.looseObject({ bootId: z.string(), version: z.string().optional(), cwd: z.string().optional() }) },
  'session.list': { mutating: false, value: z.looseObject({ items: z.array(z.looseObject({ sessionId: z.string(), updatedAt: z.number(), running: z.boolean() })) }) },
  'session.create': { mutating: true, value: z.looseObject({ sessionId: z.string() }) },
  'session.history': { mutating: false, value: z.looseObject({ events: z.array(z.looseObject({ event: z.looseObject({ type: z.string(), seq: z.number(), time: z.number(), data: z.unknown() }) })), hasMore: z.boolean() }) },
  'session.workStatus': { mutating: false, value: z.looseObject({ messageId: z.string(), status: messageState }) },
  'session.models': { mutating: false, value: z.looseObject({ current: z.looseObject({ provider: z.string(), model: z.string() }), groups: z.array(z.looseObject({ id: z.string(), name: z.string(), models: z.array(z.looseObject({ id: z.string(), name: z.string() })) })) }) },
  'session.selectModel': { mutating: true, value: z.looseObject({ selected: z.looseObject({ provider: z.string(), model: z.string() }) }) },
  'session.selectModelTarget': {
    mutating: true,
    value: z.looseObject({
      target: z.looseObject({ kind: z.string() }),
      selected: z.looseObject({ provider: z.string(), model: z.string() }),
    }),
  },
  'session.rename': { mutating: true, value: z.looseObject({ title: z.string(), seq: z.number() }) },
  'session.prompt': { mutating: true, value: z.looseObject({ accepted: z.literal(true), messageId: z.string(), operationId: z.string() }) },
  'session.updateQueue': { mutating: true, value: z.looseObject({ accepted: z.literal(true), messageId: z.string(), status: messageState }) },
  'session.cancel': { mutating: true, value: z.looseObject({ accepted: z.literal(true) }) },
} as const

/** A method the bridge may call through {@link UNARY_ENDPOINTS}. */
export type UnaryMethod = keyof typeof UNARY_ENDPOINTS

/** Response value of one unary method. */
export type UnaryValue<M extends UnaryMethod> = z.infer<(typeof UNARY_ENDPOINTS)[M]['value']>

/** Typert `/api/<endpoint>` rows: `{ args }` payload, response value stays wide. */
export const TYPERT_ENDPOINTS = ['commands/execute'] as const

/** A Typert endpoint the bridge may call. */
export type TypertEndpoint = (typeof TYPERT_ENDPOINTS)[number]

/** Carrier endpoints reached outside the unary table. */
export const CARRIER_ENDPOINTS = {
  respond: '/api/respond',
  upload: '/api/attachment/upload',
  mux: '/api/events.mux',
} as const

/**
 * Narrow a method name to the closed unary table.
 * @param method - candidate method.
 * @returns whether the bridge may call it.
 */
export function isUnaryMethod(method: string): method is UnaryMethod {
  return Object.hasOwn(UNARY_ENDPOINTS, method)
}

/**
 * Narrow an endpoint name to the closed Typert table.
 * @param endpoint - candidate endpoint.
 * @returns whether the bridge may call it.
 */
export function isTypertEndpoint(endpoint: string): endpoint is TypertEndpoint {
  return (TYPERT_ENDPOINTS as readonly string[]).includes(endpoint)
}
