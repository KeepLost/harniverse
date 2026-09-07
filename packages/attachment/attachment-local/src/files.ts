/**
 * Generic-file storage below the versioned attachment root: raw
 * content-addressed bytes (no sniffing, no normalization) plus the read-only
 * hard-link handle publication that gives a model a stable filesystem path to
 * read a stored file through. The link and the object share one inode, so a
 * future object-store GC cannot invalidate a handle already named in a
 * session.
 * @module dsh-attachment-local/files
 */

import { chmod, link, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentLimits,
  FileAttachmentRef,
  SaveFileAttachment,
  StoredFileAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  digest, displayName, ensureDurableDirectory, ensureDurableHome, ensureReference, objectPath, publishObject, syncDirectory,
} from './store.ts'

/** Characters a link leaf must never carry across the supported filesystems. */
const UNSAFE_LEAF_CHARACTERS = /[/\\:*?"<>|]/g

/**
 * Shape a stored display name into one safe hard-link leaf.
 * @param value - the cleaned display name from the stored reference.
 * @returns a filesystem-safe leaf, or `undefined` when nothing usable remains.
 */
function safeLeaf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const safe = value.replace(UNSAFE_LEAF_CHARACTERS, '_').trim()
  /* v8 ignore next -- displayName already trims to non-empty; replacing the
   * unsafe characters never empties a non-empty string, so this arm is
   * defensive totality over the input domain. */
  return safe === '' ? undefined : safe
}

/**
 * The read-only hard-link path a model reads one stored file through.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - the durable reference naming the object.
 * @returns the absolute link path (the link may not exist yet).
 */
function handlePath(root: string, ref: FileAttachmentRef): string {
  const sha256 = ensureReference(ref)
  const sha8 = sha256.slice(0, 8)
  const leaf = safeLeaf(displayName(ref.name))
  return join(root, 'links', leaf === undefined ? `${sha8}.bin` : `${sha8}-${leaf}`)
}

/**
 * Save one generic file: bytes verbatim, content-addressed, deduplicated.
 * Admission is a byte cap only — no format sniffing, no normalization, no
 * media-type verification (the caller's declaration is recorded as given).
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - raw bytes and optional declared metadata.
 * @param limits - resolved storage policy.
 * @returns a durable content-addressed reference.
 */
export async function saveFileObject(
  root: string,
  input: SaveFileAttachment,
  limits: FileAttachmentLimits,
): Promise<FileAttachmentRef> {
  if (input.data.byteLength === 0) throw new AttachmentError('File is empty.', 'INVALID_FILE')
  if (input.data.byteLength > limits.maxFileBytes) {
    throw new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE')
  }
  const sha256 = await publishObject(root, input.data)
  const name = displayName(input.name)
  return {
    attachmentId: AttachmentId(`sha256:${sha256}`),
    bytes: input.data.byteLength,
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
    ...(name !== undefined ? { name } : {}),
  }
}

/**
 * Read one generic file and verify its bytes against the reference digest.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and canonical reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readFileObject(
  root: string,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredFileAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read file attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  if (data.byteLength !== ref.bytes) throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  return { ref, data }
}

/**
 * Publish (idempotently) the read-only hard link a model reads one stored
 * file through. The link and the object share one inode; making the link
 * read-only makes the shared inode read-only, which is exactly the handle
 * contract the model is told about.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @returns the absolute read-only link path.
 */
export async function publishFileHandle(root: string, ref: FileAttachmentRef): Promise<string> {
  const sha256 = ensureReference(ref)
  const target = handlePath(root, ref)
  const linksDir = join(root, 'links')
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(linksDir, boundary)
  try {
    await link(objectPath(root, sha256), target)
    await syncDirectory(linksDir)
  } catch (error) {
    // The link and its object are content-addressed: an existing link with
    // this exact name is the same inode, so re-publishing is a no-op.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      /* v8 ignore next -- publishFileHandle's guarded calls throw OS errors,
       * never AttachmentError; the re-throw arm keeps a future call change
       * from swallowing a classified failure. */
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unable to publish the file handle link.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
    }
  }
  await chmod(target, 0o444)
  return target
}
