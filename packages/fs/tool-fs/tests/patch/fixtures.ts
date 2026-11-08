/**
 * Local execution and directory fixtures for the apply_patch suites. The
 * official tests ride `dsh-tool-testkit` and the agent-loop testkit's
 * working-directory fixture; this tree executes single calls through
 * `ctx.tools.execute` and provides the directory collaborator inline.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Parsed invocation for {@link executeToolFixture}. */
export interface ToolFixtureInput {
  signal: AbortSignal
  callId: unknown
  name: string
  arguments: unknown
  agent?: Agent
}

/**
 * Run one parsed invocation through the mounted tool runtime.
 * @param ctx - context owning the tool definitions.
 * @param input - parsed invocation.
 * @returns the settled tool result.
 */
export async function executeToolFixture(ctx: Context, input: ToolFixtureInput) {
  return await ctx.tools.execute({
    signal: input.signal,
    callId: input.callId as never,
    name: input.name,
    arguments: input.arguments,
    ...input.agent === undefined ? {} : { agent: input.agent },
  })
}

/**
 * Supply fixed directory values without filesystem checks or durable changes.
 * @param ctx - context owning this test collaborator.
 * @param defaultDirectory - fallback for fixtures without a Session directory.
 */
export function provideWorkingDirectoryFixture(ctx: Context, defaultDirectory = process.cwd()): void {
  const get = (session: Session): string => session.header.cwd ?? defaultDirectory
  ctx.provide('workingDirectory', {
    defaultDirectory,
    get,
    ensure: (agent: Agent): Promise<string> => Promise.resolve(get(agent.session)),
  })
}
