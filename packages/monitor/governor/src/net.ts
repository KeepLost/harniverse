/**
 * Per-pid TCP attribution from `ss` socket-diag output: the only accurate
 * enough baseline for per-command network metering without eBPF. Parsing is
 * tolerant — a malformed block contributes nothing instead of failing the
 * tick. UDP and connections closed between ticks are out of scope by design.
 * @module @deepseek-ai/dsh-governor/net
 */

/** TCP attribution for one pid at one tick. */
export interface PidTcpStats {
  readonly bytesSent: number
  readonly bytesReceived: number
  /** Remote `host:port` peers seen this tick (bounded, deduplicated). */
  readonly peers: readonly string[]
}

/** One parse result: pid → summed socket counters. */

/**
 * Parse `ss -tinp` output into per-pid TCP byte counters and peer lists.
 * Blocks start at each non-indented state line; the indented info line that
 * follows carries the counters, and `users:(("proc",pid=N,fd=M))` names the
 * owning process.
 * @param text - raw `ss` stdout.
 * @returns pid → attribution; empty when nothing parsed.
 */
export function parseSsOutput(text: string): Map<number, PidTcpStats> {
  const result = new Map<number, { sent: number; received: number; peers: Set<string> }>()
  let block = ''
  const flush = (): void => { foldBlock(block, result); block = '' }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith(' ') || line.startsWith('\t')) {
      block += `\n${line}`
      continue
    }
    // A non-indented line starts a new block; the header row has no pid.
    flush()
    block = line
  }
  flush()
  const stats = new Map<number, PidTcpStats>()
  for (const [id, entry] of result) {
    stats.set(id, {
      bytesSent: entry.sent,
      bytesReceived: entry.received,
      peers: [...entry.peers].slice(0, 8),
    })
  }
  return stats
}

/** Fold one state-line block into the accumulating result. */
function foldBlock(block: string, result: Map<number, { sent: number; received: number; peers: Set<string> }>): void {
  if (block.length === 0) return
  const pid = /pid=(\d+)/.exec(block)
  if (pid === null) return
  const id = Number(pid[1])
  const entry = result.get(id) ?? { sent: 0, received: 0, peers: new Set<string>() }
  const sent = /bytes_sent:(\d+)/.exec(block)
  const received = /bytes_received:(\d+)/.exec(block)
  if (sent !== null) entry.sent += Number(sent[1])
  if (received !== null) entry.received += Number(received[1])
  const newline = block.indexOf('\n')
  const header = newline === -1 ? block : block.slice(0, newline)
  const peer = header.split(/\s+/)[4]
  if (peer !== undefined && peer !== '*') entry.peers.add(peer)
  result.set(id, entry)
}

/**
 * Union the peer lists of several attributions, bounded for wire transport.
 * @param stats - per-pid attributions whose peers merge.
 * @param cap - maximum peers kept (default 8).
 * @returns the deduplicated peer list.
 */
export function unionPeers(stats: readonly PidTcpStats[], cap = 8): string[] {
  const seen = new Set<string>()
  for (const stat of stats) {
    for (const peer of stat.peers) {
      if (seen.size >= cap) return [...seen]
      seen.add(peer)
    }
  }
  return [...seen]
}
