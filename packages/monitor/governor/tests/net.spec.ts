import { describe, expect, it } from 'vitest'
import { parseSsOutput, unionPeers } from '../src/net.ts'

const SS_BLOCK = (pid: number, sent: number, received: number, peer: string, fd: number): string =>
  `ESTAB 0 0 172.18.0.3:44890 ${peer} users:(("tool",pid=${pid},fd=${fd}))\n\t cubic bytes_sent:${sent} bytes_acked:${sent} bytes_received:${received} segs_out:1 segs_in:1\n`

describe('parseSsOutput', () => {
  it('attributes byte counters and peers per pid', () => {
    const text = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n'
      + SS_BLOCK(100, 1_000, 2_000, '184.26.91.235:443', 7)
      + SS_BLOCK(100, 4_000, 8_000, '43.163.179.90:443', 9)
      + SS_BLOCK(200, 10, 20, '10.0.0.1:5432', 3)
    const stats = parseSsOutput(text)
    expect(stats.get(100)).toEqual({ bytesSent: 5_000, bytesReceived: 10_000, peers: ['184.26.91.235:443', '43.163.179.90:443'] })
    expect(stats.get(200)).toEqual({ bytesSent: 10, bytesReceived: 20, peers: ['10.0.0.1:5432'] })
  })

  it('parses a single-line block with no info line', () => {
    const stats = parseSsOutput('ESTAB 0 0 1.1.1.1:2 2.2.2.2:3 users:(("solo",pid=42,fd=1))')
    expect(stats.get(42)).toEqual({ bytesSent: 0, bytesReceived: 0, peers: ['2.2.2.2:3'] })
  })

  it('skips blocks without a pid and tolerates garbage', () => {
    const text = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n'
      + 'ESTAB 0 0 1.2.3.4:5 5.6.7.8:9\n'
      + 'LISTEN 0 0 0.0.0.0:80 0.0.0.0:*\n'
      + 'not a block at all'
    expect(parseSsOutput(text).size).toBe(0)
  })

  it('keeps the peer list bounded and deduplicated', () => {
    const stats = parseSsOutput(SS_BLOCK(1, 1, 1, '9.9.9.9:443', 1) + SS_BLOCK(1, 1, 1, '9.9.9.9:443', 2))
    expect(stats.get(1)?.peers).toEqual(['9.9.9.9:443'])
  })
})

describe('unionPeers', () => {
  it('unions bounded peer lists', () => {
    expect(unionPeers([
      { bytesSent: 0, bytesReceived: 0, peers: ['a:1', 'b:2'] },
      { bytesSent: 0, bytesReceived: 0, peers: ['b:2', 'c:3'] },
    ])).toEqual(['a:1', 'b:2', 'c:3'])
    expect(unionPeers([
      { bytesSent: 0, bytesReceived: 0, peers: ['a', 'b', 'c', 'd', 'e'] },
    ], 3)).toEqual(['a', 'b', 'c'])
  })
})
