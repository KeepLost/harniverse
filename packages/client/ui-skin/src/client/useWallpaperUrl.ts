/**
 * Hold a wallpaper's object URL for as long as a view shows it.
 * @module @deepseek-ai/dsh-client-ui-skin/useWallpaperUrl
 */
import { useEffect, useState } from 'react'

/**
 * Resolve a wallpaper to an object URL, taking a reference on mount and
 * dropping it on change or unmount. A result that arrives after the view moved
 * on is ignored.
 * @param hash - wallpaper content hash.
 * @param acquire - takes a reference and resolves the URL.
 * @param release - drops the reference.
 * @returns the URL, or undefined while loading or when the wallpaper cannot be shown.
 */
export function useWallpaperUrl(
  hash: string,
  acquire: (hash: string) => Promise<string | undefined>,
  release: (hash: string) => void,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    let current = true
    setUrl(undefined)
    void acquire(hash).then((next) => { if (current) setUrl(next) })
    return () => {
      current = false
      release(hash)
    }
  }, [hash, acquire, release])
  return url
}
