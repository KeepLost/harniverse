/**
 * Exhaustiveness guard for the closed unions the bridge switches over.
 * @module @deepseek-ai/dsh-chat-bridge/never
 */

/**
 * Mark an unreachable closed-union branch.
 * @param value - the impossible value; typed `never` so a new variant fails compilation.
 * @returns never: it always throws, naming the offending value.
 */
export function assertNever(value: never): never {
  throw new Error(`chat-bridge: unreachable variant ${JSON.stringify(value)}`)
}
