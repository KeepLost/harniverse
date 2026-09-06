/**
 * Two-process lock holder: takes a raw non-blocking exclusive `flock` on the
 * given session directory's lock file through the C library (no workspace
 * imports: the fixture runs under plain Node), prints `holding`, and keeps the
 * kernel lock until the parent SIGKILLs this process (a crash: release never
 * runs).
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import koffi from 'koffi'

const [dir] = process.argv.slice(2)
if (dir === undefined) {
  process.stderr.write('usage: node lease-holder.mjs <session-dir>\n')
  process.exit(2)
}

const LOCK_EX = 2
const LOCK_NB = 4
const libc = koffi.load('libc.so.6')
const flock = libc.func('flock', 'int', ['int', 'int'])

const handle = await open(join(dir, 'session.lock'), 'w')
if (flock(handle.fd, LOCK_EX | LOCK_NB) !== 0) {
  process.stdout.write('failed\n')
  process.exit(1)
}
process.stdout.write('holding\n')
// Keep the descriptor (and with it the kernel lock) until killed; never close.
setInterval(() => {}, 1000)
