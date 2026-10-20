/**
 * Ask the browser for one local audio file through a transient hidden input.
 * Resolves undefined when the picker is dismissed; the input element leaves
 * the document either way.
 *
 * @returns the chosen file, or undefined on cancel.
 */
export function pickAudioFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | undefined): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => { finish(input.files?.[0]) })
    input.addEventListener('cancel', () => { finish(undefined) })
    document.body.appendChild(input)
    input.click()
  })
}
