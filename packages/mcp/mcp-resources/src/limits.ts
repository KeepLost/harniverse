/** Complete retained resource result ceiling, including binary data and metadata. */
export const MAX_RESOURCE_RESULT_BYTES = 1_048_576

/**
 * Reject an oversized decoded resource result before publishing or retaining it.
 * @param value - SDK-validated or provider-owned JSON result.
 * @returns the original value when the complete serialized result fits.
 */
export function boundedResourceResult<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESOURCE_RESULT_BYTES) {
    throw new Error(`MCP resource result exceeds ${MAX_RESOURCE_RESULT_BYTES} bytes`)
  }
  return value
}
