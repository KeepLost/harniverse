/** Linux process-tree RSS observation used by benchmarks and their runner. */

import { readFile } from 'node:fs/promises'

export async function processTreeRssMb(rootPid: number): Promise<number> {
  const pids = await processTreePids(rootPid)
  const values = await Promise.all(pids.map(async (pid) => {
    try {
      const status = await readFile(`/proc/${String(pid)}/status`, 'utf8')
      const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)
      return match?.[1] === undefined ? 0 : Number(match[1]) / 1_024
    } catch {
      return 0
    }
  }))
  return values.reduce((sum, value) => sum + value, 0)
}

export async function processTreePids(rootPid: number): Promise<number[]> {
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift() as number
    let childrenText = ''
    try {
      childrenText = await readFile(`/proc/${String(parent)}/task/${String(parent)}/children`, 'utf8')
    } catch {
      childrenText = ''
    }
    for (const raw of childrenText.trim().split(/\s+/u).filter(Boolean)) {
      const child = Number(raw)
      if (!Number.isSafeInteger(child) || seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return [...seen]
}
