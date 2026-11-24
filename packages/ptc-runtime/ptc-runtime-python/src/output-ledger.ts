/** Bounded output accounting for the Python provider; text fragments only. */
import type { PtcJsonValue, PtcOutput, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'

function jsonCharacterBytes(character: string): number {
  const code = character.codePointAt(0) as number
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return 6
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

function jsonStringBytesUpTo(text: string, maxBytes: number): number | undefined {
  let bytes = 2
  if (bytes > maxBytes) return undefined
  for (const character of text) {
    bytes += jsonCharacterBytes(character)
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

function truncateJsonString(text: string, maxBytes: number): string {
  let bytes = 2
  let end = 0
  for (const character of text) {
    const cost = jsonCharacterBytes(character)
    if (bytes + cost > maxBytes) break
    bytes += cost
    end += character.length
  }
  return text.slice(0, end)
}

type JsonMeterTask = { value: unknown } | { key: string; value: unknown }

function* arrayMeterTasks(value: unknown[]): Generator<JsonMeterTask> {
  for (const item of value) yield { value: item }
}

function* objectMeterTasks(value: Record<string, unknown>): Generator<JsonMeterTask> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield { key, value: value[key] }
  }
}

function numberJson(value: number): string {
  return Number.isInteger(value) && !Number.isSafeInteger(value) ? BigInt(value).toString() : String(value)
}

function jsonValueBytesUpTo(value: PtcJsonValue, maxBytes: number): number | undefined {
  let bytes = 0
  const cursors: Iterator<JsonMeterTask>[] = [[{ value }].values()]
  while (cursors.length > 0) {
    const cursor = cursors.at(-1) as Iterator<JsonMeterTask>
    const step = cursor.next()
    if (step.done === true) {
      cursors.pop()
      continue
    }
    const task = step.value
    if ('key' in task) {
      const keyBytes = jsonStringBytesUpTo(task.key, maxBytes - bytes)
      if (keyBytes === undefined) return undefined
      bytes += keyBytes + 1
    }
    const current = task.value
    if (typeof current === 'string') {
      const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes)
      if (stringBytes === undefined) return undefined
      bytes += stringBytes
    } else if (typeof current === 'number') {
      bytes += Buffer.byteLength(numberJson(current), 'utf8')
    } else if (typeof current === 'boolean') {
      bytes += current ? 4 : 5
    } else if (current === null) {
      bytes += 4
    } else if (Array.isArray(current)) {
      bytes += 2 + Math.max(0, current.length - 1)
      if (bytes + current.length > maxBytes) return undefined
      cursors.push(arrayMeterTasks(current))
    } else {
      const record = current as Record<string, unknown>
      let count = 0
      for (const key in record) if (Object.hasOwn(record, key)) count++
      bytes += 2 + Math.max(0, count - 1)
      if (bytes + count * 4 > maxBytes) return undefined
      cursors.push(objectMeterTasks(record))
    }
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

/* jscpd:ignore-start -- deliberate mirror of dsh-ptc-runtime-node/src/output-ledger.ts:
 * the same bounded-ledger contract, kept local to avoid a cross-backend dependency. */
/** One run's combined outer-output ledger; binding values never enter it. */
export class OutputLedger {
  private bytes = 2
  private entries = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  /** Admit one ordered text entry against the combined output budget; Python emits text fragments only. */
  admit(entry: PtcOutput, sink: PtcOutput[]): boolean {
    if (this.truncated) return false
    const separator = this.entries > 0 ? 1 : 0
    const remaining = this.maxBytes - this.bytes - separator
    const bytes = entryBytes(entry, remaining)
    if (bytes === undefined) {
      this.truncated = true
      if (entry.type === 'text') {
        const prefix = truncateJsonString(entry.text, remaining)
        if (prefix.length > 0) sink.push({ type: 'text', text: prefix })
      }
      return false
    }
    this.bytes += bytes + separator
    this.entries += 1
    sink.push(entry)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(output: PtcOutput[], value?: PtcJsonValue): PtcRunResult {
    const valueBytes = value === undefined ? 0 : jsonValueBytesUpTo(value, this.maxBytes - 2)
    if (valueBytes === undefined) return this.failure(output, { kind: 'output-limit', message: `completion value exceeded ${this.maxBytes} bytes` })
    return { ...this.retain(output, valueBytes), ...value !== undefined ? { value } : {} }
  }

  /** Prioritize the terminal diagnostic without changing its failure kind. */
  failure(output: PtcOutput[], error: PtcRunFailure): PtcRunResult {
    const message = truncateJsonString(error.message, this.maxBytes - 2)
    if (message !== error.message) this.truncated = true
    return { ...this.retain(output, Buffer.byteLength(JSON.stringify(message))), error: { ...error, message } }
  }

  /** Keep an ordered prefix after reserving bytes for the completion or diagnostic. */
  private retain(output: PtcOutput[], terminalBytes: number): Pick<PtcRunResult, 'output' | 'outputTruncated'> {
    const retained: PtcOutput[] = []
    const ledger = new OutputLedger(this.maxBytes - terminalBytes)
    for (const entry of output) {
      if (!ledger.admit(entry, retained)) break
    }
    this.truncated ||= ledger.truncated
    return { output: retained, ...this.truncated ? { outputTruncated: true } : {} }
  }
}

/** Measure a text entry against the remaining JSON-byte budget (Python emits text fragments only). */
function entryBytes(entry: PtcOutput, available: number): number | undefined {
  return entry.type === 'text' ? jsonStringBytesUpTo(entry.text, available) : undefined
}

/* jscpd:ignore-end */
