/**
 * Read or change the calling session's working directory.
 *
 * @module @deepseek-ai/dsh-tool-working-directory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis plugin name. */
export const name = 'tool-working-directory'
/** Services used by the tool. */
export const inject = ['tools', 'workingDirectory']

/** Canonical tool output: the effective absolute directory after the call. */
interface WorkingDirectoryValue {
  cwd: string
}

const WORKING_DIRECTORY_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cwd: { type: 'string', required: true, description: 'Current absolute working directory.' },
  },
} as const

/**
 * Register the working-directory tool for this composition.
 * @param ctx - context providing the tool registry and directory owner.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'working_directory',
    description: 'Read the current working directory, or change it with cd. Relative paths use '
      + 'the current directory. Existing shells and running processes keep their own directories.',
    parameters: {
      cd: { type: 'string', description: 'Existing directory to enter. Omit to read the current directory.' },
    },
    output: {
      schema: WORKING_DIRECTORY_VALUE_SCHEMA,
      render: (_args: Record<string, never>, value: WorkingDirectoryValue) => [{ type: 'text', text: value.cwd }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('working_directory requires a calling agent session')
      const cwd = args.cd === undefined
        ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : await ctx.workingDirectory.set(exec.agent, args.cd, exec.signal)
      const value: WorkingDirectoryValue = { cwd }
      return value
    },
    presentCall: args => ({ card: 'generic', title: 'working_directory', rawInput: args }),
  }))
}
