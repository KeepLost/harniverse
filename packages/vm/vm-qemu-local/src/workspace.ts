/**
 * Workspace data plane: deterministic ustar snapshots moved between host
 * and guest over two virtio-blk images, plus the control-protocol client
 * that drives the guest-side import/export operations.
 *
 * The v0 workspace form is explicit bulk transfer (the R1 decision): the
 * host stages one immutable import image before boot and reads one export
 * image after the guest reports completion — no shared filesystem, no
 * 9p server, the world keeps owning its filesystem. Both images share one
 * on-disk layout: a 4096-byte header (`DSHWSI01`, payload length) followed
 * by the tar payload, so a reader never trusts more than the first header
 * block before knowing exactly how many payload bytes exist.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { isOpReplyFor, parseGuestMessage, type ControlTransport } from './protocol.ts'

/** Magic bytes every workspace image header starts with. */
const WORKSPACE_MAGIC = 'DSHWSI01'

/** Header size in bytes; the payload always starts at this offset. */
export const WORKSPACE_HEADER_BYTES = 4096

/** Default export image capacity: matches the wrapper's 1 GiB per-file rlimit. */
export const DEFAULT_EXPORT_CAPACITY_BYTES = 1 << 30

/** Reply deadline for one workspace operation; bulk transfers are slow by design. */
const WORKSPACE_REPLY_TIMEOUT_MS = 120_000

/** Block alignment every tar payload keeps. */
const TAR_BLOCK = 512

/** Fixed archive timestamp (2000-01-01 UTC) so packed tars are byte-deterministic. */
const TAR_EPOCH = 946_684_800

/** One workspace directory entry inside a snapshot tar. */
export type WorkspaceEntry = { path: string; kind: 'dir' } | { path: string; kind: 'file'; data: Uint8Array }

/** Host-side diff between two snapshot tars, in file terms. */
export interface WorkspaceDiff {
  /** Files absent from the base or with different bytes in the next snapshot. */
  changed: WorkspaceEntry[]
  /** Base file paths the next snapshot dropped. */
  removed: string[]
}

/** Raised when a tar payload is not a ustar archive this module can parse. */
export class WorkspaceTarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceTarError'
  }
}

/** Raised when a workspace image header is missing, foreign, or oversized. */
export class WorkspaceImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceImageError'
  }
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function writeString(block: Buffer, offset: number, text: string, length: number): void {
  block.write(text, offset, length, 'utf8')
}

function splitName(path: string): { name: string; prefix: string } | undefined {
  if (path.length <= 100) return { name: path, prefix: '' }
  for (let cut = 0; cut <= 155 && cut < path.length - 1; cut += 1) {
    if (path[cut] === '/' && path.length - cut - 1 <= 100) {
      return { name: path.slice(cut + 1), prefix: path.slice(0, cut) }
    }
  }
  return undefined
}

/** One entry with its payload normalized: directories carry empty bytes. */
interface PackedEntry {
  path: string
  kind: 'file' | 'dir'
  data: Buffer
}

function entryHeader(entry: PackedEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK)
  const split = splitName(entry.path)
  if (split === undefined) throw new WorkspaceTarError(`path too long for ustar: ${entry.path}`)
  writeString(header, 0, split.name, 100)
  writeString(header, 100, octal(entry.kind === 'dir' ? 0o755 : 0o644, 8), 8)
  writeString(header, 108, octal(0, 8), 8)
  writeString(header, 116, octal(0, 8), 8)
  writeString(header, 124, octal(entry.data.length, 12), 12)
  writeString(header, 136, octal(TAR_EPOCH, 12), 12)
  header.fill(' ', 148, 156)
  header.write(entry.kind === 'dir' ? '5' : '0', 156, 1, 'utf8')
  writeString(header, 257, 'ustar', 6)
  header.write('00', 263, 2, 'utf8')
  writeString(header, 265, 'root', 32)
  writeString(header, 297, 'root', 32)
  writeString(header, 345, split.prefix, 155)
  let checksum = 0
  for (const byte of header) checksum += byte
  writeString(header, 148, checksum.toString(8).padStart(6, '0') + '\0 ', 8)
  return header
}

/** Paths this snapshot's implicit directory set covers (no trailing slashes). */
function parentDirs(path: string): string[] {
  const dirs: string[] = []
  let cut = path.indexOf('/')
  while (cut > 0) {
    dirs.push(path.slice(0, cut))
    cut = path.indexOf('/', cut + 1)
  }
  return dirs
}

function sortedEntries(entries: readonly WorkspaceEntry[]): PackedEntry[] {
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  for (const entry of [...byPath.values()]) {
    if (entry.kind !== 'file') continue
    for (const dir of parentDirs(entry.path)) {
      if (!byPath.has(dir)) byPath.set(dir, { path: dir, kind: 'dir' })
    }
  }
  return [...byPath.values()]
    .map(entry => ({ ...entry, data: entry.kind === 'file' ? Buffer.from(entry.data) : Buffer.alloc(0) }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function validatePath(path: string): void {
  if (path.startsWith('/') || path === '' || path === '.' || path.includes('..') || path.includes('\0')) {
    throw new WorkspaceTarError(`invalid archive path: ${JSON.stringify(path)}`)
  }
}

/**
 * Pack workspace entries as one deterministic ustar archive.
 * @param entries - files and directories; parent directories are implicit.
 * @returns the tar bytes, block-aligned and terminated.
 */
export function packWorkspaceTar(entries: readonly WorkspaceEntry[]): Buffer {
  for (const entry of entries) validatePath(entry.path)
  const blocks: Buffer[] = []
  for (const entry of sortedEntries(entries)) {
    blocks.push(entryHeader(entry))
    blocks.push(entry.data)
    const padding = (TAR_BLOCK - (entry.data.length % TAR_BLOCK)) % TAR_BLOCK
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(TAR_BLOCK * 2))
  return Buffer.concat(blocks)
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim()
  const value = /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN
  if (Number.isNaN(value)) throw new WorkspaceTarError(`malformed tar numeric field: ${JSON.stringify(text)}`)
  return value
}

function normalizeArchivePath(raw: string): string {
  let path = raw
  while (path.startsWith('./')) path = path.slice(2)
  return path.replace(/\/+$/, '')
}

/**
 * Parse one ustar archive into workspace entries.
 * @param tar - tar bytes as produced by {@link packWorkspaceTar} or busybox tar.
 * @returns normalized entries; the archive-root `.` entry busybox emits for
 * `tar cf - .` is dropped.
 */
export function readWorkspaceTar(tar: Uint8Array): WorkspaceEntry[] {
  const buffer = Buffer.from(tar)
  if (buffer.length < TAR_BLOCK * 2) throw new WorkspaceTarError('tar shorter than the terminator blocks')
  const entries: WorkspaceEntry[] = []
  let offset = 0
  for (;;) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    if (header.length < TAR_BLOCK) throw new WorkspaceTarError('tar truncated inside a header')
    if (header.every(byte => byte === 0)) break
    const name = readString(header, 0, 100)
    if (name === '') throw new WorkspaceTarError('tar header without a name')
    const size = parseOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header.subarray(156, 157).readUInt8(0))
    const prefix = readString(header, 345, 155)
    if (header.readUInt32BE(257) !== 0x75737461 /* "usta" */) {
      throw new WorkspaceTarError('tar is not ustar format')
    }
    const path = normalizeArchivePath(prefix === '' ? name : `${prefix}/${name}`)
    offset += TAR_BLOCK
    if (path === '') continue
    if (typeFlag === '5') {
      entries.push({ path, kind: 'dir' })
      continue
    }
    if (typeFlag !== '0') throw new WorkspaceTarError(`unsupported tar entry type ${JSON.stringify(typeFlag)} for ${path}`)
    if (offset + size > buffer.length) throw new WorkspaceTarError(`tar truncated inside ${path}`)
    entries.push({ path, kind: 'file', data: buffer.subarray(offset, offset + size) })
    offset += size + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK)
  }
  return entries
}

function fileMap(tar: Uint8Array): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const entry of readWorkspaceTar(tar)) {
    if (entry.kind === 'file') files.set(entry.path, Buffer.from(entry.data))
  }
  return files
}

/**
 * Diff two snapshot tars in file terms.
 * @param base - the snapshot the world started from.
 * @param next - a later export from the same world.
 * @returns changed files (next's bytes) and removed base paths.
 */
export function diffWorkspaceTars(base: Uint8Array, next: Uint8Array): WorkspaceDiff {
  const baseFiles = fileMap(base)
  const nextFiles = fileMap(next)
  const changed: WorkspaceEntry[] = []
  for (const [path, data] of nextFiles) {
    const before = baseFiles.get(path)
    if (before === undefined || !before.equals(data)) changed.push({ path, kind: 'file', data })
  }
  const removed = [...baseFiles.keys()].filter(path => !nextFiles.has(path))
  return { changed, removed }
}

/**
 * Apply a workspace diff to a base snapshot, producing the next full tar.
 * @param base - the snapshot the diff was taken against.
 * @param diff - the diff to apply.
 * @returns the resulting full snapshot tar.
 */
export function applyWorkspaceDiff(base: Uint8Array, diff: WorkspaceDiff): Buffer {
  const files = fileMap(base)
  for (const path of diff.removed) files.delete(path)
  for (const entry of diff.changed) {
    if (entry.kind === 'file') files.set(entry.path, Buffer.from(entry.data))
  }
  return packWorkspaceTar([...files.entries()].map(([path, data]) => ({ path, kind: 'file' as const, data })))
}

/**
 * Stage one workspace import image: header plus tar payload.
 * @param tar - the snapshot tar the world imports.
 * @returns image bytes sized `header + payload`.
 */
export function buildWorkspaceImage(tar: Uint8Array): Buffer {
  const payload = Buffer.from(tar)
  const image = Buffer.alloc(WORKSPACE_HEADER_BYTES + payload.length)
  image.write(WORKSPACE_MAGIC, 0, 'utf8')
  image.writeBigUInt64BE(BigInt(payload.length), 8)
  payload.copy(image, WORKSPACE_HEADER_BYTES)
  return image
}

/**
 * Parse one workspace image produced by the host or the guest agent.
 * @param image - the raw image bytes.
 * @returns the tar payload and its length.
 */
export function readWorkspaceImage(image: Uint8Array): { tar: Buffer; bytes: number } {
  const buffer = Buffer.from(image)
  if (buffer.length < WORKSPACE_HEADER_BYTES) throw new WorkspaceImageError('workspace image shorter than its header')
  if (buffer.subarray(0, 8).toString('utf8') !== WORKSPACE_MAGIC) {
    throw new WorkspaceImageError('workspace image magic mismatch')
  }
  const bytes = Number(buffer.readBigUInt64BE(8))
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WorkspaceImageError('workspace image length out of range')
  if (WORKSPACE_HEADER_BYTES + bytes > buffer.length) {
    throw new WorkspaceImageError(`workspace image truncated: ${bytes} payload bytes expected`)
  }
  return { tar: buffer.subarray(WORKSPACE_HEADER_BYTES, WORKSPACE_HEADER_BYTES + bytes), bytes }
}

/**
 * Validate a tar before it becomes the world's import payload.
 * @param tar - candidate snapshot bytes.
 * @throws WorkspaceTarError when the payload cannot be parsed as ustar.
 */
export function assertValidWorkspaceTar(tar: Uint8Array): void {
  if (tar.length % TAR_BLOCK !== 0) throw new WorkspaceTarError('tar length is not block-aligned')
  readWorkspaceTar(tar)
}

/**
 * Workspace client bound to one world's control channel and export image.
 * The guest answers each operation exactly once; `busy` arrives as an error.
 * Operations reject before any guest round trip when the world booted
 * without workspace images.
 */
export class WorldWorkspace {
  constructor(
    private readonly transport: ControlTransport,
    private readonly allocateId: () => number,
    private readonly readExportImage: (() => Promise<Uint8Array>) | undefined,
  ) {}

  private assertConfigured(): void {
    if (this.readExportImage === undefined) throw new Error('workspace not configured for this world')
  }

  private async roundTrip(message: { t: 'workspace.import' | 'workspace.export'; id: number }): Promise<{ bytes: number }> {
    const payload = await this.transport.request(
      message,
      reply => isOpReplyFor(reply, message.id, ['workspace.ok', 'workspace.err']),
      WORKSPACE_REPLY_TIMEOUT_MS,
    )
    const reply = parseGuestMessage(payload)
    if (reply === undefined || (reply.t !== 'workspace.ok' && reply.t !== 'workspace.err')) {
      throw new Error('unparseable workspace reply')
    }
    if (reply.t === 'workspace.err') throw new Error(`workspace operation failed: ${reply.message}`)
    return { bytes: reply.bytes }
  }

  /**
   * Unpack the staged import image into the guest's `/workspace`, replacing
   * whatever the directory held.
   * @returns the unpacked payload size in bytes.
   */
  async import(): Promise<{ bytes: number }> {
    this.assertConfigured()
    return await this.roundTrip({ t: 'workspace.import', id: this.allocateId() })
  }

  /**
   * Pack the guest's `/workspace` into the export image and read it back.
   * @returns the exported snapshot tar and its size in bytes.
   */
  async export(): Promise<{ tar: Buffer; bytes: number }> {
    const readExportImage = this.readExportImage
    if (readExportImage === undefined) throw new Error('workspace not configured for this world')
    const { bytes } = await this.roundTrip({ t: 'workspace.export', id: this.allocateId() })
    const { tar, bytes: payloadBytes } = readWorkspaceImage(await readExportImage())
    if (payloadBytes !== bytes) {
      throw new Error(`workspace export size mismatch: guest reported ${bytes}, image holds ${payloadBytes}`)
    }
    return { tar, bytes }
  }
}
