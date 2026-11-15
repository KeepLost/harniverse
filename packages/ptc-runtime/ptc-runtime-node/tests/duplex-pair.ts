/** Cross-wired duplex pairs for in-memory transport tests. */
import { Duplex, PassThrough } from 'node:stream'
import type { ReadableWritablePair } from 'node:stream/web'

/**
 * Build one cross-wired duplex pair over two `PassThrough` streams: what one
 * side writes, the other reads. `Duplex.from`'s declared union lacks the
 * node-stream pair form its runtime documents, so the pair is named through
 * the closest declared branch; duplexify still receives the real streams.
 * @returns the `[child, host]` ends of the pair.
 */
export function duplexPair(): [Duplex, Duplex] {
  const first = new PassThrough()
  const second = new PassThrough()
  const child = Duplex.from({ readable: first, writable: second } as unknown as ReadableWritablePair)
  const host = Duplex.from({ readable: second, writable: first } as unknown as ReadableWritablePair)
  return [child, host]
}
