/** One-shot authentication management runner. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  addAuthenticationToken,
  deleteAuthenticationToken,
  listAuthenticationTokens,
  resetAuthenticationToken,
} from '@deepseek-ai/dsh-authentication-local'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { AuthOperation } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-runner'

/** Parsed app invocation required before management starts. */
export const inject = ['authStartup']

/** Authentication management runner configuration. */
export interface Config {
  /** Selected token operation. */
  operation: AuthOperation
  /** Token name for add, reset, and delete. */
  name?: string
  /** Harness home containing the local token registry. */
  dshHome?: string
}

/** Loader validation for the runner row. */
export const Config: z<Config> = z.object({
  operation: z.union([z.const('add'), z.const('reset'), z.const('delete'), z.const('list')]).required(),
  name: z.string(),
  dshHome: z.string(),
})

interface TextOutput {
  write(value: string): unknown
}

/** Process streams used by the runner; tests replace them with captures. */
export const internals: { stdout: TextOutput; stderr: TextOutput } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Execute one operation and request bounded process exit. */
async function run(config: Config, exit: (code: number) => void): Promise<void> {
  const options = config.dshHome === undefined ? {} : { dshHome: config.dshHome }
  if (config.operation !== 'list' && config.name === undefined) {
    throw new Error(`auth-runner: ${config.operation} requires a token name`)
  }
  switch (config.operation) {
    case 'add': {
      const created = await addAuthenticationToken(config.name as string, options)
      internals.stdout.write(`${created.token}\n`)
      break
    }
    case 'reset': {
      const reset = await resetAuthenticationToken(config.name as string, options)
      internals.stdout.write(`${reset.token}\n`)
      break
    }
    case 'delete':
      await deleteAuthenticationToken(config.name as string, options)
      break
    case 'list': {
      const tokens = await listAuthenticationTokens(options)
      for (const token of tokens) {
        internals.stdout.write(`${token.name}\t${token.createdAt}\t${token.rotatedAt ?? '-'}\n`)
      }
      break
    }
    /* v8 ignore next 2 -- Loader validation and the closed AuthOperation union exclude another operation */
    default:
      config.operation satisfies never
  }
  exit(0)
}

/**
 * Mount the one-shot management runner.
 * @param ctx - plugin context carrying the launcher's exit request.
 * @param config - selected management operation and Harness home.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('auth-runner: the launcher must provide ctx.appExit before the tree mounts')
  void run(config, exit).catch((error: unknown) => {
    let message: string
    /* v8 ignore else -- local management APIs reject Error instances */
    if (error instanceof Error) message = error.message
    else message = String(error)
    internals.stderr.write(`dsh: ${message}\n`)
    exit(1)
  })
}
