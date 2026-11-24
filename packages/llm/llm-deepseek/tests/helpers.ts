/** Shared fixtures for the DeepSeek provider suites. */

/**
 * Parse the `multipart/form-data` body of a recorded Files upload the way a server receives it.
 * @param init - request options that the Files client passed to `fetch`.
 * @returns the decoded form fields.
 */
export async function uploadedForm(init: RequestInit | undefined): Promise<FormData> {
  if (!(init?.body instanceof Uint8Array)) throw new Error('expected an encoded multipart body')
  return await new Request('http://localhost/v1/files', { method: 'POST', headers: init.headers, body: init.body }).formData()
}
