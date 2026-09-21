/** Shared provider limits and Files API defaults. */

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 256_000
/** Default total pixel budget for normal-detail request images. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2_048 * 2_048
/** Default total pixel budget for low-detail request images. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Default encoded bytes for one request image. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1 * 1024 * 1024
/** Default aggregate bytes represented by Files API references. */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
/** Default aggregate bytes represented by inline image data. */
export const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum retained image count. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** Default byte offload quantum for file representations. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024
/** Default byte offload quantum for inline representations. */
export const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** Default image-count offload quantum. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
/** Default deadline for resolving one Files API image. */
export const DEFAULT_FILES_API_TIMEOUT_MS = 60_000
/** Default requested remote file lifetime. */
export const DEFAULT_FILE_EXPIRY_SECONDS = 7 * 24 * 60 * 60
/** Default refresh margin before remote file expiry. */
export const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 60 * 60
/** Default number of provider files removed during quota recovery. */
export const DEFAULT_FILE_QUOTA_CLEANUP_BATCH = 100
