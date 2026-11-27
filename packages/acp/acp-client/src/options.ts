/**
 * Reading of the session options an agent reports: its modes and its
 * configuration options, when a session opens and after every later change.
 * A malformed entry is left out, and a malformed whole reads as none.
 * @module @deepseek-ai/dsh-acp-client/options
 */

import { isRecord } from './update.ts'
import type { AcpConfigChoice, AcpConfigOption, AcpSessionMode, AcpSessionModes } from './types.ts'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** An optional `description`; absent when the value is not a string. */
function description(value: unknown): { readonly description?: string } {
  const read = text(value)
  return read === undefined ? {} : { description: read }
}

/**
 * Read the modes of one session setup or mode report.
 * @param value - the raw `modes` object.
 * @returns the modes, or `undefined` when the value carries none.
 */
export function readSessionModes(value: unknown): AcpSessionModes | undefined {
  if (!isRecord(value) || typeof value.currentModeId !== 'string' || !Array.isArray(value.availableModes)) return undefined
  const available: AcpSessionMode[] = []
  for (const item of value.availableModes) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue
    available.push({ id: item.id, name: item.name, ...description(item.description) })
  }
  return { current: value.currentModeId, available }
}

function readChoices(value: unknown): AcpConfigChoice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const choices: AcpConfigChoice[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    // A group carries its own options; the group's name labels each of them.
    if (Array.isArray(item.options)) {
      const group = text(item.name)
      if (group === undefined) continue
      for (const option of item.options) {
        const choice = readChoice(option)
        if (choice !== undefined) choices.push({ ...choice, group })
      }
      continue
    }
    const choice = readChoice(item)
    if (choice !== undefined) choices.push(choice)
  }
  return choices
}

function readChoice(value: unknown): AcpConfigChoice | undefined {
  if (!isRecord(value) || typeof value.value !== 'string' || typeof value.name !== 'string') return undefined
  return { value: value.value, name: value.name, ...description(value.description) }
}

/**
 * Read one configuration option. An option whose declared type this client
 * does not know, and a malformed choice, is left out rather than guessed at.
 * @param value - one entry of a raw `configOptions` list.
 * @returns the option, or `undefined` when the entry is malformed or unknown.
 */
export function readConfigOption(value: unknown): AcpConfigOption | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id) ?? text(value.configId)
  const name = text(value.name)
  if (id === undefined || name === undefined) return undefined
  const current = value.currentValue
  const type = value.type === 'select' || (value.type === undefined && typeof current === 'string')
    ? 'select'
    : value.type === 'boolean' || (value.type === undefined && typeof current === 'boolean') ? 'boolean' : undefined
  if (type === undefined) return undefined
  const category = text(value.category)
  const shared = { id, name, ...description(value.description), ...category === undefined ? {} : { category } }
  if (type === 'boolean') {
    return typeof current === 'boolean' ? { ...shared, type, currentValue: current } : undefined
  }
  if (typeof current !== 'string') return undefined
  const options = readChoices(value.options)
  return options === undefined ? undefined : { ...shared, type, currentValue: current, options }
}

/**
 * Read every configuration option of one report.
 * @param value - a raw `configOptions` list.
 * @returns the well-formed options, or `undefined` when the value is no list.
 */
export function readConfigOptions(value: unknown): AcpConfigOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: AcpConfigOption[] = []
  for (const item of value) {
    const option = readConfigOption(item)
    if (option !== undefined) options.push(option)
  }
  return options
}
