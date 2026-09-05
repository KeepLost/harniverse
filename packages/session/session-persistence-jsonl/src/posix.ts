/**
 * POSIX `flock(2)` binding for the session write lease, loaded through the
 * same Koffi FFI the backend already uses for its Windows helpers. Failures
 * carry the raw C `errno` (no symbolic `code`); the lease's contention check
 * accepts both spellings so fs-style errors and this binding's errors stay
 * interchangeable.
 *
 * @module dsh-session-persistence-jsonl/posix
 */

type Flock = (fd: number, operation: number) => number
type Errno = () => number

interface PosixBindings {
  flock: Flock
  errno: Errno
}

const LOCK_EX = 2
const LOCK_NB = 4

let bindings: PosixBindings | undefined

/** Load the small C API lazily so Windows processes never load Koffi libc. */
async function posix(): Promise<PosixBindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  /* v8 ignore next -- native macOS coverage loads libSystem; Linux covers the libc.so.6 peer */
  const libc = koffi.load(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6')
  bindings = {
    flock: libc.func('flock', 'int', ['int', 'int']) as Flock,
    errno: () => koffi.errno(),
  }
  return bindings
}

/**
 * Take a non-blocking exclusive `flock` on an open descriptor; the kernel
 * drops it when the descriptor (or its process) closes.
 * @param fd - the open lock-file descriptor.
 * @throws a Node-style errno error whose `errno` is the raw C value.
 */
export async function flockExnbPosix(fd: number): Promise<void> {
  const api = await posix()
  if (api.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const error = new Error(`flock errno ${api.errno()}: fd ${fd}`) as NodeJS.ErrnoException
    error.errno = api.errno()
    error.syscall = 'flock'
    throw error
  }
}
