/**
 * Browser download of generated text.
 * @module @deepseek-ai/dsh-client-ui-skin/download
 */

/** How long the object URL lives after the click; the download starts synchronously, the margin covers slow browsers. */
export const REVOKE_DELAY_MS = 1000

/**
 * Offer a text document as a file download.
 * @param fileName - suggested file name.
 * @param text - document body (served as JSON).
 */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, REVOKE_DELAY_MS)
}
