/**
 * File reading for uploads. `FileReader` is the one browser API that reads a
 * picked file without holding a second copy of it in script memory first, and
 * it yields base64 directly for the wallpaper wire.
 * @module @deepseek-ai/dsh-client-ui-skin/files
 */

/** Run one FileReader read and settle with its string result. */
function read(start: (reader: FileReader) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(reader.result as string) }
    reader.onerror = () => { reject(new Error(`file read failed: ${String(reader.error)}`)) }
    start(reader)
  })
}

/**
 * Read a file as base64 text.
 * @param file - the picked file.
 * @returns the standard-alphabet base64 of its bytes (no data-URL header).
 */
export async function readAsBase64(file: Blob): Promise<string> {
  const url = await read((reader) => { reader.readAsDataURL(file) })
  return url.slice(url.indexOf(',') + 1)
}

/**
 * Read a file as UTF-8 text.
 * @param file - the picked file.
 * @returns the decoded text.
 */
export function readAsText(file: Blob): Promise<string> {
  return read((reader) => { reader.readAsText(file) })
}
