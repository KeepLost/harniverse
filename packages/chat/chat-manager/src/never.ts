/**
 * Exhaustiveness guard for closed unions.
 * @module @deepseek-ai/dsh-chat-manager/never
 */

/**
 * Fail loudly when a closed union gains a member this code does not handle.
 * @param value - the value TypeScript proved unreachable.
 * @returns never; it always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`chat-manager: unexpected value ${JSON.stringify(value)}`)
}
