/** Combined byte accounting for retained program output. */
import type { PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'

/** One run's combined outer-output ledger; binding values never enter it. */
export class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number, private readonly overflowMessage?: string) {}

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Admit the fitting prefix of one overflowing entry, preserving an ordered prefix of captured output. */
  admitPrefix(text: string, sink: string[]): void {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const availableBytes = this.maxBytes - this.bytes - separatorBytes
    const prefix = truncateJsonStringBytes(text, availableBytes)
    if (prefix.length === 0) return
    const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
    /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
    if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
    this.bytes += prefixBytes + separatorBytes
    this.entries += 1
    sink.push(prefix)
  }

  /**
   * Finalize a successful absent-or-JSON completion against the combined cap.
   * The required completion value is prioritized: logs that do not fit beside
   * it keep their fitting prefix and the result carries `outputTruncated`. A
   * value that cannot fit even with empty logs fails with `output-limit`.
   */
  success(logs: string[], value?: PtcJsonValue): PtcRunResult {
    if (value === undefined) return { logs }
    const valueBytes = jsonValueBytesUpTo(value, this.maxBytes - 2)
    if (valueBytes === undefined) return this.limit(logs)
    if (jsonValueBytesUpTo(value, this.maxBytes - this.bytes) !== undefined) return { logs, value }
    // Reaching here means the value fits only after logs are cut, so the
    // prefix always truncates.
    const retained = this.logPrefixWithin(logs, this.maxBytes - 2 - valueBytes)
    return { logs: retained.logs, value, outputTruncated: true }
  }

  /**
   * Finalize a failure diagnostic. The diagnostic is bounded, never
   * reclassified: a message that does not fit beside the retained logs keeps
   * its fitting prefix, logs are cut first, and the failure kind survives with
   * `outputTruncated`.
   */
  failure(logs: string[], error: PtcRunFailure): PtcRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) !== undefined) return { logs, error }
    const message = truncateJsonStringBytes(error.message, this.maxBytes - 2)
    // truncateJsonStringBytes returned a fitting prefix, so it measures; the
    // fallback only names the empty-string floor.
    /* v8 ignore next -- a fitting truncated diagnostic always measures. */
    const messageBytes = jsonStringBytesUpTo(message, this.maxBytes - 2) ?? 2
    // Reaching here means the diagnostic fits only after logs are cut, so the
    // result always truncates.
    const retained = this.logPrefixWithin(logs, this.maxBytes - 2 - messageBytes)
    return { logs: retained.logs, error: { ...error, message }, outputTruncated: true }
  }

  /**
   * Build the `output-limit` failure for a required payload that cannot fit,
   * retaining a fitting prefix of the final log.
   */
  limit(logs: string[]): PtcRunResult {
    const fullMessage = this.overflowMessage ?? `outer output exceeded ${this.maxBytes} bytes`
    // The fixed diagnostic is ASCII, so every character is one byte plus the quotes.
    const messageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    const message = truncateJsonStringBytes(fullMessage, availableMessageBytes)
    return { logs: retained, error: { kind: 'output-limit', message }, outputTruncated: true }
  }

  /**
   * Keep the fitting prefix of `logs` within `budget` combined bytes.
   * @param logs - the admitted log entries, in order.
   * @param budget - combined bytes the prefix may occupy.
   * @returns the prefix, its exact byte count, and whether anything was dropped.
   */
  private logPrefixWithin(logs: readonly string[], budget: number): { logs: string[]; bytes: number; truncated: boolean } {
    const retained: string[] = []
    let retainedBytes = 2
    let truncated = false
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = budget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      /* v8 ignore next 4 -- a zero-length prefix means nothing fits, which the byte math of `availableBytes` already bounds. */
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      truncated = true
      break
    }
    return { logs: retained, bytes: retainedBytes, truncated }
  }
}
