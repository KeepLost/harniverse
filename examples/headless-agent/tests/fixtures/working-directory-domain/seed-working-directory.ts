/** Test-only Loader plugin: init a repository, cd once, then create and enter a worktree. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-worktree'
import type {} from '@deepseek-ai/dsh-working-directory'

export const name = 'seed-working-directory'
export const inject = ['subprocess', 'workingDirectory', 'worktrees']

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const owner = agent.ctx
    if (owner.get('worktrees') === undefined) return next()
    const started = agent.session.events.some(event => event.type === 'working-directory/change')
    if (!started) {
      // The child's working directory is an empty temp dir: make it a repository
      // with one commit so the worktree flow has a real local baseline.
      const run = (argv: string[]) => ctx.subprocess.spawn({
        argv,
        cwd: agent.session.header.cwd ?? process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 3000,
        signal,
      })
      await (await run(['git', 'init', '-b', 'main'])).done
      await (await run(['git', 'config', 'user.email', 'smoke@example.com'])).done
      await (await run(['git', 'config', 'user.name', 'Working Directory Smoke'])).done
      const { writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = agent.session.header.cwd ?? process.cwd()
      await writeFile(join(root, 'baseline.txt'), 'baseline\n')
      await (await run(['git', 'add', '.'])).done
      await (await run(['git', 'commit', '-m', 'baseline'])).done
      await ctx.workingDirectory.set(agent, 'nested', signal).catch(async () => {
        await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'nested')))
        await ctx.workingDirectory.set(agent, 'nested', signal)
      })
      // Return to the repository root before allocating the worktree.
      await ctx.workingDirectory.set(agent, root, signal)
      await ctx.worktrees.create(agent, { name: 'smoke-worktree' }, signal)
    }
    return next()
  })
}
