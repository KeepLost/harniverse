/**
 * Filesystem surface over the control channel: the eight semantic ops
 * (read, write, stat, list, mkdir, unlink, rmdir, rename) as one round
 * trip each, with guest errnos mapped to Node-style codes.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { isOpReplyFor, parseGuestMessage, type ControlTransport, type FsOkMessage, type FsStatWire, type FsWireOp, type FsEntryWire } from './protocol.ts'

/** Largest payload one writeFile call may carry (mirrors the guest cap). */
export const MAX_FS_PAYLOAD_BYTES = 512 * 1024

/** Reply deadline for one fs round trip. */
const FS_REPLY_TIMEOUT_MS = 10_000

/** A guest fs operation failed; `code` follows the Node fs naming. */
export class GuestFsError extends Error {
  constructor(
    public readonly code: string,
    public readonly errno: number,
    message: string,
  ) {
    super(`guest fs error ${code} (errno ${errno}): ${message}`)
    this.name = 'GuestFsError'
  }
}

/** Guest file facts as reported by `stat`. */
export type GuestStat = FsStatWire

/** One directory entry as reported by `list`. */
export type GuestEntry = FsEntryWire

const ERRNO_CODES: Record<number, string> = {
  1: 'EPERM',
  2: 'ENOENT',
  5: 'EIO',
  13: 'EACCES',
  17: 'EEXIST',
  20: 'ENOTDIR',
  21: 'EISDIR',
  22: 'EINVAL',
  27: 'EFBIG',
  28: 'ENOSPC',
  36: 'ENAMETOOLONG',
  39: 'ENOTEMPTY',
}

function codeFor(errno: number): string {
  return ERRNO_CODES[errno] ?? 'EIO'
}

/**
 * Filesystem client bound to one world's control channel.
 */
export class WorldFs {
  constructor(
    private readonly transport: ControlTransport,
    private readonly allocateId: () => number,
  ) {}

  private async roundTrip(op: FsWireOp): Promise<FsOkMessage> {
    const id = this.allocateId()
    const payload = await this.transport.request(
      { t: 'fs', id, ...op },
      reply => isOpReplyFor(reply, id, ['fs.ok', 'fs.err']),
      FS_REPLY_TIMEOUT_MS,
    )
    const reply = parseGuestMessage(payload)
    if (reply === undefined) throw new GuestFsError('EIO', 0, 'unparseable fs reply')
    if (reply.t === 'fs.err') throw new GuestFsError(codeFor(reply.errno), reply.errno, reply.message)
    if (reply.t !== 'fs.ok') throw new GuestFsError('EIO', 0, 'unexpected fs reply')
    return reply
  }

  /**
   * Read one guest file.
   * @param path - absolute guest path.
   * @returns the file bytes; files above the wire cap reject with EFBIG.
   */
  async readFile(path: string): Promise<Buffer> {
    const reply = await this.roundTrip({ op: 'read', path })
    return Buffer.from(reply.d ?? '', 'base64')
  }

  /**
   * Write one guest file, truncating or creating it.
   * @param path - absolute guest path.
   * @param data - bytes or UTF-8 text; at most {@link MAX_FS_PAYLOAD_BYTES}.
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (bytes.length > MAX_FS_PAYLOAD_BYTES) {
      throw new GuestFsError('EFBIG', 27, `write payload exceeds ${MAX_FS_PAYLOAD_BYTES} bytes`)
    }
    await this.roundTrip({ op: 'write', path, d: bytes.toString('base64') })
  }

  /**
   * Stat one guest path.
   * @param path - absolute guest path.
   * @returns kind, size, permission bits, and mtime.
   */
  async stat(path: string): Promise<GuestStat> {
    const reply = await this.roundTrip({ op: 'stat', path })
    if (reply.st === undefined) throw new GuestFsError('EIO', 0, 'stat reply without st')
    return reply.st
  }

  /**
   * List one guest directory.
   * @param path - absolute guest directory.
   * @returns its entries with file/dir kinds.
   */
  async list(path: string): Promise<GuestEntry[]> {
    const reply = await this.roundTrip({ op: 'list', path })
    return reply.entries ?? []
  }

  /**
   * Create one directory.
   * @param path - absolute guest path.
   * @param options - `recursive` creates parents like `mkdir -p`.
   */
  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.roundTrip(options.recursive === true ? { op: 'mkdir', path, recursive: true } : { op: 'mkdir', path })
  }

  /**
   * Remove one guest file.
   * @param path - absolute guest path.
   */
  async unlink(path: string): Promise<void> {
    await this.roundTrip({ op: 'unlink', path })
  }

  /**
   * Remove one empty guest directory.
   * @param path - absolute guest path.
   */
  async rmdir(path: string): Promise<void> {
    await this.roundTrip({ op: 'rmdir', path })
  }

  /**
   * Rename or move one guest path.
   * @param from - absolute source path.
   * @param to - absolute destination path.
   */
  async rename(from: string, to: string): Promise<void> {
    await this.roundTrip({ op: 'rename', from, to })
  }
}
