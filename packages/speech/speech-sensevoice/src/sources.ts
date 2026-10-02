/** Source probing: prefer the first reachable Hugging Face-compatible origin. */

/** Minimal fetch face so suites can substitute a scripted implementation. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Prefer the first origin whose HEAD probe answers ok while retaining the
 * others as download fallback. All probes settle before returning; when every
 * probe fails, the configured order is preserved (downloads can still work
 * when an origin refuses HEAD). A single origin needs no probe.
 * @param assetUrl - revision-pinned upstream file URL.
 * @param origins - nonempty configured origins.
 * @param timeoutMs - maximum probe duration, including redirects.
 * @param signal - preparation cancellation.
 * @param fetchImpl - fetch implementation; defaults to the global fetch.
 * @returns deduplicated download URLs with the first responding source first.
 */
export async function orderSources(
  assetUrl: string,
  origins: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  signal?.throwIfAborted()
  const path = new URL(assetUrl).pathname
  const urls = [...new Set(origins.map(origin => new URL(path, origin).href))]
  if (urls.length === 1) return urls
  const finished = new AbortController()
  const timeout = setTimeout(() => { finished.abort() }, timeoutMs)
  const probing = signal === undefined ? finished.signal : AbortSignal.any([signal, finished.signal])
  const requests = urls.map(async url => ({ url, response: await fetchImpl(url, { method: 'HEAD', signal: probing }) }))
  let preferred: string | undefined
  try {
    preferred = await Promise.any(requests.map(async (request) => {
      const { url, response } = await request
      if (!response.ok) throw new Error(`source probe returned HTTP ${String(response.status)}`)
      return url
    }))
  } catch (_everyProbeFailed) {
    // Downloads can still work when every origin refuses HEAD or times out.
  } finally {
    clearTimeout(timeout)
    finished.abort()
    const settled = await Promise.allSettled(requests)
    await Promise.allSettled(settled.map(async (result) => {
      if (result.status === 'fulfilled') await result.value.response.body?.cancel()
    }))
  }
  signal?.throwIfAborted()
  return preferred === undefined ? urls : [preferred, ...urls.filter(url => url !== preferred)]
}
