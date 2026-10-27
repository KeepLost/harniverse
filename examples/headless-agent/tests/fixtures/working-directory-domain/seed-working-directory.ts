/** Test-only Loader plugin: init a repository, cd once, then create and enter a worktree. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-worktree'
import type {} from '@deepseek-ai/dsh-working-directory'

export const name = 'seed-working-directory'
export const inject = ['subprocess', 'workingDirectory', 'worktrees']

/** Run one git command to completion in the session's directory. */
async function runGit(ctx: Context, cwd: string, argv: string[], signal: AbortSignal): Promise<void> {
  const child = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 3_000,
    signal,
  })
  await child.done
}

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent.ctx.get('worktrees') === undefined) return next()
    const started = agent.session.events.some(event => event.type === 'working-directory/change')
    if (!started) {
      // The child's working directory is an empty temp dir: make it a repository
      // with one commit so the worktree flow has a real local baseline.
      const root = agent.session.header.cwd ?? process.cwd()
      await runGit(ctx, root, ['git', 'init', '-b', 'main'], signal)
      await runGit(ctx, root, ['git', 'config', 'user.email', 'smoke@example.com'], signal)
      await runGit(ctx, root, ['git', 'config', 'user.name', 'Working Directory Smoke'], signal)
      await writeFile(join(root, 'baseline.txt'), 'baseline\n')
      await runGit(ctx, root, ['git', 'add', '.'], signal)
      await runGit(ctx, root, ['git', 'commit', '-m', 'baseline'], signal)
      const nested = join(root, 'nested')
      await import('node:fs/promises').then(fs => fs.mkdir(nested, { recursive: true }))
      await ctx.workingDirectory.set(agent, nested, signal)
      // Return to the repository root before allocating the worktree.
      await ctx.workingDirectory.set(agent, root, signal)
      await ctx.worktrees.create(agent, { name: 'smoke-worktree' }, signal)
    }
    return next()
  })
}
