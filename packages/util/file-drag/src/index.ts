/** File export naming for original-file transfers; the native drag half is deferred (see README). */
import mime from 'mime'

/** Caller-supplied export naming, shared by Web and Desktop. */
export interface DragFileName {
  readonly name?: string | undefined
  readonly mediaType: string
  readonly outputExtension?: string | undefined
}

/**
 * Resolve one platform-safe export filename. Explicit suffix wins; compatible suffixes survive.
 * A known conflicting suffix is replaced from MIME; unknown MIME never rejects a supplied name.
 * @param request - caller name, declared content type, and optional explicit suffix.
 * @returns cleaned filename, with MIME-derived suffix only when needed.
 */
export function resolveDragFileName(request: DragFileName): string {
  const { name = 'file', mediaType, outputExtension } = request
  let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '') || 'file'
  const dot = clean.lastIndexOf('.')
  const suffix = dot < 0 ? '' : clean.slice(dot + 1)
  const declared = mediaType.replace(/;.*$/su, '').trim().toLowerCase()
  const preferred = mime.getExtension(declared)
  const explicit = outputExtension?.replace(/^\./u, '').replace(/[^a-z\d_-]/giu, '')
  const compatible = mime.getAllExtensions(declared)?.has(suffix.toLowerCase()) === true
  const extension = explicit || (suffix === '' || (preferred !== null && !compatible) ? preferred : suffix)
  if (extension) clean = `${dot < 0 ? clean : clean.slice(0, dot)}.${extension}`
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(clean)) clean = `_${clean}`
  const finalDot = clean.lastIndexOf('.')
  const tail = finalDot < 0 ? '' : clean.slice(finalDot)
  const encoder = new TextEncoder()
  const truncate = (value: string, bytes: number): string => {
    let result = ''
    for (const character of value) {
      const length = encoder.encode(character).length
      if (length > bytes) break
      result += character
      bytes -= length
    }
    return result
  }
  const extensionTail = truncate(tail, 32)
  return `${truncate(finalDot < 0 ? clean : clean.slice(0, finalDot), 255 - encoder.encode(extensionTail).length)}${extensionTail}`
}
