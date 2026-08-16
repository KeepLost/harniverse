/** Boot-free named authentication token management commands. */
import {
  addAuthenticationToken,
  deleteAuthenticationToken,
  listAuthenticationTokens,
  resetAuthenticationToken,
} from '@deepseek-ai/dsh-authentication-local'
import type { AuthTokenInvocation } from './args.ts'

interface TextOutput {
  write(value: string): unknown
}

/** Runtime dependencies for token management command output and storage. */
export interface AuthTokenCommandOptions {
  dshHome?: string
  stdout?: TextOutput
}

/** Execute one boot-free token management invocation. */
export async function runAuthToken(
  invocation: AuthTokenInvocation,
  options: AuthTokenCommandOptions = {},
): Promise<void> {
  const management = options.dshHome === undefined ? {} : { dshHome: options.dshHome }
  const stdout = options.stdout ?? process.stdout
  switch (invocation.operation) {
    case 'add': {
      const created = await addAuthenticationToken(invocation.name, management)
      stdout.write(`${created.token}\n`)
      return
    }
    case 'reset': {
      const reset = await resetAuthenticationToken(invocation.name, management)
      stdout.write(`${reset.token}\n`)
      return
    }
    case 'delete':
      await deleteAuthenticationToken(invocation.name, management)
      return
    case 'list': {
      const tokens = await listAuthenticationTokens(management)
      for (const token of tokens) {
        stdout.write(`${token.name}\t${token.createdAt}\t${token.rotatedAt ?? '-'}\n`)
      }
      return
    }
    default:
      invocation satisfies never
  }
}
