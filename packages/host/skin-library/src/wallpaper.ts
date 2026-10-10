/**
 * Wallpaper intake rules: size ceilings, strict base64 decoding, file-signature
 * sniffing, and the content address (lowercase hex SHA-256) a wallpaper is
 * stored and requested under. Pure functions over bytes; the store owns disk.
 * @module @deepseek-ai/dsh-host-skin-library/wallpaper
 */

import { createHash } from 'node:crypto'
import type { WallpaperMime, WallpaperRejectionReason } from './types.ts'

/** Largest accepted wallpaper, in decoded bytes. */
export const MAX_WALLPAPER_BYTES = 8 * 1024 * 1024

/** Most wallpapers kept at once. */
export const MAX_WALLPAPERS = 24

/** A wallpaper's content address: 64 lowercase hex digits. */
export const WALLPAPER_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Every stored wallpaper kind. */
export const WALLPAPER_MIMES: readonly WallpaperMime[] = ['image/png', 'image/jpeg', 'image/webp']

/** File extension each stored wallpaper kind carries. */
export const WALLPAPER_EXTENSIONS: Readonly<Record<WallpaperMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Base64 characters needed for the largest wallpaper, padding included. */
const MAX_ENCODED_LENGTH = Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

/** Whether `bytes` carries `signature` starting at `offset`. */
function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * Decide an image's kind from its leading bytes, ignoring any declared type
 * or file name. SVG, GIF, and AVIF are deliberately unsupported.
 * @param bytes - the candidate image bytes.
 * @returns the kind, or `undefined` when the bytes are not PNG, JPEG, or WebP.
 */
export function sniffWallpaperMime(bytes: Uint8Array): WallpaperMime | undefined {
  if (hasSignature(bytes, PNG_SIGNATURE)) return 'image/png'
  if (hasSignature(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  if (hasSignature(bytes, RIFF) && hasSignature(bytes, WEBP, 8)) return 'image/webp'
  return undefined
}

/**
 * Content address of a wallpaper.
 * @param bytes - the exact stored bytes.
 * @returns lowercase hex SHA-256.
 */
export function wallpaperHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read a stored wallpaper's content address and kind from its file name.
 * @param name - a file name inside the wallpapers directory.
 * @returns the hash and kind of a `<sha256>.<ext>` name, or `undefined` for any other name.
 */
export function parseWallpaperFileName(name: string): { readonly hash: string; readonly mime: WallpaperMime } | undefined {
  const parts = name.split('.')
  const [hash, extension] = parts
  if (parts.length !== 2 || hash === undefined || extension === undefined || !WALLPAPER_HASH_PATTERN.test(hash)) {
    return undefined
  }
  const mime = WALLPAPER_MIMES.find(candidate => WALLPAPER_EXTENSIONS[candidate] === extension)
  return mime === undefined ? undefined : { hash, mime }
}

/** Outcome of {@link decodeWallpaper}. */
type DecodedWallpaper =
  | { readonly ok: true; readonly bytes: Buffer; readonly mime: WallpaperMime }
  | { readonly ok: false; readonly reason: Exclude<WallpaperRejectionReason, 'limit-reached'> }

/**
 * Decode and vet one uploaded wallpaper. The encoded length is bounded before
 * any decoding; the text must be canonical padded base64 (no whitespace,
 * URL-safe digits, or stray characters); the decoded size is bounded again;
 * and the bytes must carry a PNG, JPEG, or WebP signature.
 * @param contentBase64 - the upload, base64-encoded.
 * @returns the decoded bytes and their kind, or the reason for refusal.
 */
export function decodeWallpaper(contentBase64: string): DecodedWallpaper {
  if (contentBase64.length > MAX_ENCODED_LENGTH) return { ok: false, reason: 'too-large' }
  const bytes = Buffer.from(contentBase64, 'base64')
  // Node's decoder skips invalid characters; a canonical round trip rejects them.
  if (bytes.toString('base64') !== contentBase64) return { ok: false, reason: 'invalid-encoding' }
  if (bytes.length > MAX_WALLPAPER_BYTES) return { ok: false, reason: 'too-large' }
  const mime = sniffWallpaperMime(bytes)
  return mime === undefined ? { ok: false, reason: 'unsupported-type' } : { ok: true, bytes, mime }
}
