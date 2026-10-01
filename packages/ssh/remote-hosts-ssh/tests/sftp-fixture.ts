/** In-memory files behind a real SSH SFTP subsystem. */
import { utils, type SFTPWrapper } from 'ssh2'
import type { EventEmitter } from 'node:events'

export interface FixtureFile { data: Buffer; mode: number }

export function serveSftp(sftp: SFTPWrapper, files: Map<string, FixtureFile>, events: EventEmitter, holds: Set<string>) {
  sftp.on('end', () => { sftp.end() })
  const { STATUS_CODE, OPEN_MODE } = utils.sftp
  const handles = new Map<string, string>()
  let next = 0
  let chmodCount = 0
  sftp.on('error', () => {}) // Transport cancellation is exercised by the client tests.
  sftp.on('OPEN', (id: number, path: string, flags: number, attrs: { mode?: number }) => {
    if (path === '/denied') { sftp.status(id, STATUS_CODE.PERMISSION_DENIED); return }
    if (!files.has(path)) {
      if (!(flags & OPEN_MODE.CREAT)) { sftp.status(id, STATUS_CODE.NO_SUCH_FILE); return }
      files.set(path, { data: Buffer.alloc(0), mode: attrs.mode ?? 0o644 })
    }
    if (flags & OPEN_MODE.TRUNC) files.get(path)!.data = Buffer.alloc(0)
    const handle = Buffer.from(String(++next))
    handles.set(handle.toString(), path)
    sftp.handle(id, handle)
  })
  sftp.on('CLOSE', (id: number, handle: Buffer) => {
    handles.delete(handle.toString())
    sftp.status(id, STATUS_CODE.OK)
  })
  sftp.on('FSTAT', (id: number, handle: Buffer) => {
    const file = files.get(handles.get(handle.toString())!)!
    sftp.attrs(id, { mode: file.mode, size: file.data.length, uid: 0, gid: 0, atime: 0, mtime: 0 })
  })
  sftp.on('FSETSTAT', (id: number, handle: Buffer, attrs: { mode?: number }) => {
    if (holds.has('chmod') || (holds.has('repeated-chmod') && ++chmodCount > 1)) {
      sftp.status(id, STATUS_CODE.PERMISSION_DENIED)
      return
    }
    const file = files.get(handles.get(handle.toString())!)!
    if (attrs.mode !== undefined) file.mode = attrs.mode
    sftp.status(id, STATUS_CODE.OK)
  })
  sftp.on('READ', (id: number, handle: Buffer, offset: number, length: number) => {
    events.emit('read')
    if (holds.has('read')) return
    const file = files.get(handles.get(handle.toString())!)!
    if (offset >= file.data.length) sftp.status(id, STATUS_CODE.EOF)
    else sftp.data(id, file.data.subarray(offset, offset + length))
  })
  sftp.on('WRITE', (id: number, handle: Buffer, offset: number, data: Buffer) => {
    events.emit('write')
    if (holds.has('write')) return
    const file = files.get(handles.get(handle.toString())!)!
    if (file.data.length < offset + data.length) {
      const larger = Buffer.alloc(offset + data.length)
      file.data.copy(larger)
      file.data = larger
    }
    data.copy(file.data, offset)
    sftp.status(id, STATUS_CODE.OK)
  })
  sftp.on('REALPATH', (id: number, path: string) => {
    sftp.name(id, [{ filename: path === '.' ? '/home/fixture' : path, longname: '',
      attrs: { mode: 0o700, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }])
  })
  sftp.on('MKDIR', (id: number, path: string, attrs: { mode: number }) => {
    if (files.has(path)) { sftp.status(id, STATUS_CODE.FAILURE); return }
    files.set(path, { data: Buffer.alloc(0), mode: attrs.mode })
    sftp.status(id, STATUS_CODE.OK)
  })
}
