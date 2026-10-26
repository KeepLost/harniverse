/**
 * Complete repository typecheck: the Host aggregate build and the source-only
 * Typert generation run concurrently, then the Client aggregate build runs
 * once both have passed. Bundling stays in `build:lib:*`; this path checks
 * types and produces the generated declarations the Client program reads.
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** One spawnable step of the typecheck plan. */
export interface PlannedCommand {
  readonly label: string
  readonly args: readonly string[]
}

/** The complete typecheck plan: two concurrent producers, one consumer. */
export interface TypecheckPlan {
  readonly host: PlannedCommand
  readonly typert: PlannedCommand
  readonly client: PlannedCommand
}

/**
 * Build the plan against one repository root. The Typert step spawns through
 * the invoking package manager (`npm_execpath`, as `build.ts` does) so the
 * same command works on every platform without a shell.
 * @param root - repository root.
 * @param packageManager - the package-manager CLI path; defaults to the
 *   invoking `npm_execpath`, which every package script provides.
 * @returns the three commands and their labels.
 */
export function typecheckPlan(root: string, packageManager = process.env.npm_execpath): TypecheckPlan {
  if (packageManager === undefined || packageManager === '') {
    throw new Error('typecheck: npm_execpath is unavailable; invoke the check through a package script')
  }
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
  return {
    host: {
      label: 'host tsc',
      args: [process.execPath, '--max-old-space-size=6144', tsc, '-b', 'tsconfig.host.json'],
    },
    typert: {
      label: 'typert generation',
      args: [process.execPath, packageManager, 'run', 'generate-typert'],
    },
    client: {
      label: 'client tsc',
      args: [process.execPath, tsc, '-b', 'tsconfig.client.json'],
    },
  }
}

/**
 * Orchestrate the plan: host and typert run concurrently; the client runs
 * only after both succeed, so its diagnostics never cascade over a failed
 * producer.
 * @param plan - the commands to run.
 * @param run - spawn seam receiving one command's label.
 * @returns the first nonzero exit code, or the client's exit code.
 */
export async function runTypecheck(plan: TypecheckPlan, run: (label: string) => Promise<number>): Promise<number> {
  const [hostCode, typertCode] = await Promise.all([run(plan.host.label), run(plan.typert.label)])
  if (hostCode !== 0) return hostCode
  if (typertCode !== 0) return typertCode
  return run(plan.client.label)
}

function spawnCommand(root: string, command: PlannedCommand): Promise<number> {
  console.log(`typecheck: ${command.label} (${command.args.join(' ')})`)
  return new Promise((resolvePromise, rejectPromise) => {
    const [entry, ...rest] = command.args
    if (entry === undefined) throw new Error(`typecheck: ${command.label} has no command`)
    const child = spawn(entry, rest, { cwd: root, stdio: 'inherit' })
    child.on('error', rejectPromise)
    child.on('close', (code: number | null) => { resolvePromise(code ?? 1) })
  })
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  const plan = typecheckPlan(root)
  const commands = new Map<string, PlannedCommand>([
    [plan.host.label, plan.host],
    [plan.typert.label, plan.typert],
    [plan.client.label, plan.client],
  ])
  const code = await runTypecheck(plan, (label) => {
    const command = commands.get(label)
    if (command === undefined) throw new Error(`typecheck: unknown step ${JSON.stringify(label)}`)
    return spawnCommand(root, command)
  })
  if (code !== 0) process.exitCode = code
}

if (import.meta.main) {
  await main()
}
