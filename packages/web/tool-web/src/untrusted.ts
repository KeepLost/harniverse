/** Model-facing handling for content returned by any Web provider. */

/** Fixed boundary placed around Web content before it reaches the model. */
export const WEB_UNTRUSTED_PREFIX = '--- BEGIN UNTRUSTED WEB CONTENT ---\n'
/** Fixed boundary placed after Web content before it reaches the model. */
export const WEB_UNTRUSTED_SUFFIX = '\n--- END UNTRUSTED WEB CONTENT ---'

/** Only role tags that can impersonate a message role are removed. */
const ROLE_TAG = /<\/?(?:system|developer|user|assistant|tool|function)\b[^>]*>/gi

/**
 * Remove narrow role-like HTML tags without changing the surrounding content.
 * @param text - provider-returned text.
 * @returns text without the selected role-like tags.
 */
export function sanitizeWebText(text: string): string {
  return text.replace(ROLE_TAG, '')
}

/**
 * Wrap already-sanitized Web content in an explicit untrusted-content boundary.
 * @param text - content that has already been sanitized for role-like tags.
 * @returns the content enclosed by the fixed Web safety boundary.
 */
export function wrapWebText(text: string): string {
  return WEB_UNTRUSTED_PREFIX + text + WEB_UNTRUSTED_SUFFIX
}
