/**
 * Display formatting shared by the session-import surfaces.
 * @module @deepseek-ai/dsh-client-ui-session-import/format
 */

/**
 * A byte count in the largest binary unit that keeps it at or above one.
 * @param bytes - non-negative byte count.
 * @returns e.g. `512 B`, `1.5 KiB`, `64 MiB`.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${String(rounded)} ${units[unit] as string}`
}

/**
 * A local calendar timestamp, minute precision, in a locale-independent shape.
 * @param ms - Unix epoch milliseconds.
 * @returns `YYYY-MM-DD HH:mm` in the browser's time zone.
 */
export function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Base64 of a byte array, in chunks small enough for argument spreading.
 * @param bytes - the bytes to encode.
 * @returns the standard-alphabet base64 text.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
