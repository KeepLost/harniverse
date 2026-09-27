import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { parseRecord, RemoteHostsError } from './validation.ts'
import type { HostRecord, RemoteHostId } from './types.ts'

/** Single-local-process registry; the composing app owns the Harness home lease. */
export class HostRegistry {
  private records: HostRecord[] = []
  private tail: Promise<void> = Promise.resolve()
  readonly path: string
  constructor(private readonly home: string) { this.path = join(home, 'remote-hosts.json') }
  async load(): Promise<void> {
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new RemoteHostsError('INVALID_REGISTRY')
      const document = z.strictObject({ version: z.literal(1), hosts: z.array(z.unknown()).max(1024) }).parse(JSON.parse(await readFile(this.path, 'utf8')))
      const records = document.hosts.map(parseRecord)
      if (new Set(records.map(record => record.id)).size !== records.length) throw new RemoteHostsError('INVALID_REGISTRY')
      this.records = records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RemoteHostsError('INVALID_REGISTRY')
    }
  }
  list(): HostRecord[] { return structuredClone(this.records) }
  get(id: RemoteHostId): HostRecord {
    const record = this.records.find(item => item.id === id)
    if (record === undefined) throw new RemoteHostsError('HOST_NOT_FOUND')
    return structuredClone(record)
  }
  put(record: HostRecord): Promise<void> {
    const detached = parseRecord(record)
    return this.commit(records => [...records.filter(item => item.id !== record.id), detached])
  }
  remove(id: RemoteHostId): Promise<void> { return this.commit(records => records.filter(item => item.id !== id)) }
  private commit(change: (records: HostRecord[]) => HostRecord[]): Promise<void> {
    const work = this.tail.then(async () => {
      const records = change(this.records)
      if (records.length > 1024) throw new RemoteHostsError('REGISTRY_FULL')
      const serialized = JSON.stringify({ version: 1, hosts: records }) + '\n'
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new RemoteHostsError('REGISTRY_FULL')
      await mkdir(this.home, { recursive: true, mode: 0o700 })
      const temporary = join(this.home, `.remote-hosts-${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try {
        try {
          await file.writeFile(serialized)
          await file.sync()
        } finally { await file.close() }
        await rename(temporary, this.path)
        this.records = records
      } finally {
        try { await unlink(temporary) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    })
    this.tail = work.catch(() => {}) // A rejected commit does not poison subsequent registry operations.
    return work
  }
}
