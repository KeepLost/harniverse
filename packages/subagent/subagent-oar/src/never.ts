/**
 * Exhaustiveness guard for the closed unions the provider switches over.
 * @module @deepseek-ai/dsh-subagent-oar/never
 */

/**
 * Mark an unreachable closed-union branch.
 * @param value - the impossible value; typed `never` so a new variant fails compilation.
 * @returns never: it always throws, naming the offending value.
 */
export function assertNever(value: never): never {
  throw new Error(`subagent-oar: unreachable variant ${JSON.stringify(value)}`)
}
