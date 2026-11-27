/**
 * Reading of `elicitation/create`: an agent asking the person a question in
 * the middle of its work, or asking them to open an address. A request this
 * client cannot put to a person is reported as unsupported, so the answerer
 * declines it instead of guessing.
 * @module @deepseek-ai/dsh-acp-client/question
 */

import { isRecord } from './update.ts'
import type { AcpQuestionChoice, AcpQuestionField, AcpQuestionRequest } from './types.ts'

/** What one raw request carries. */
export type AcpQuestionParse =
  | { readonly kind: 'form'; readonly request: AcpQuestionRequest }
  | { readonly kind: 'url'; readonly url: string }
  /** An unknown mode, or a field this client cannot express. */
  | { readonly kind: 'unsupported' }

const UNSUPPORTED: AcpQuestionParse = { kind: 'unsupported' }

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The choices of one field: a plain list of values, or titled values. `undefined` when there are none. */
function readChoices(values: unknown, titled: unknown): AcpQuestionChoice[] | undefined {
  if (Array.isArray(values) && values.length > 0) {
    return values.every(item => typeof item === 'string') ? values.map(item => ({ value: item, label: item })) : undefined
  }
  if (!Array.isArray(titled) || titled.length === 0) return undefined
  const choices: AcpQuestionChoice[] = []
  for (const item of titled) {
    if (!isRecord(item) || typeof item.const !== 'string' || typeof item.title !== 'string') return undefined
    const description = text(item.description)
    choices.push({ value: item.const, label: item.title, ...description === undefined ? {} : { description } })
  }
  return choices
}

function readField(name: string, schema: unknown, required: boolean): AcpQuestionField | undefined {
  if (!isRecord(schema)) return undefined
  const label = text(schema.title) ?? name
  const base = { name, label, required }
  switch (schema.type) {
    case 'string': {
      const choices = readChoices(schema.enum, schema.oneOf)
      return choices === undefined ? { type: 'text', ...base } : { type: 'choice', ...base, options: choices, multi: false }
    }
    case 'number':
    case 'integer':
      return { type: 'number', ...base }
    case 'boolean':
      return { type: 'boolean', ...base }
    case 'array': {
      const items = isRecord(schema.items) ? schema.items : {}
      const choices = readChoices(items.enum, items.anyOf)
      return choices === undefined ? undefined : { type: 'choice', ...base, options: choices, multi: true }
    }
    default:
      return undefined
  }
}

/**
 * Read one raw `elicitation/create` params object.
 * @param params - the request params off the wire.
 * @param signal - aborts when the agent withdraws the request.
 * @returns the question, the address to open, or `unsupported`.
 */
export function readQuestion(params: unknown, signal: AbortSignal): AcpQuestionParse {
  if (!isRecord(params) || typeof params.message !== 'string') return UNSUPPORTED
  if (params.mode === 'url') {
    return typeof params.url === 'string' ? { kind: 'url', url: params.url } : UNSUPPORTED
  }
  if (params.mode !== 'form') return UNSUPPORTED
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {}
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : []
  if (properties.length === 0) return UNSUPPORTED
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [])
  const fields: AcpQuestionField[] = []
  for (const [name, definition] of properties) {
    const field = readField(name, definition, required.has(name))
    if (field === undefined) return UNSUPPORTED
    fields.push(field)
  }
  return { kind: 'form', request: { message: params.message, fields, signal } }
}
