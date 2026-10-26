import { describe, expect, it } from 'vitest'

import { runTypecheck, typecheckPlan } from './typecheck.ts'

/** Recording fake for the spawn boundary; commands run only when released. */
class PlannedRuns {
  readonly started: string[] = []
  private readonly waiting: { label: string; resolve: (code: number) => void }[] = []

  run(label: string): Promise<number> {
    this.started.push(label)
    return new Promise((resolve) => { this.waiting.push({ label, resolve }) })
  }

  /** Finish every started command with the given label, keeping the rest pending. */
  finish(label: string, code = 0): void {
    for (const entry of this.waiting.splice(0, this.waiting.length)) {
      if (entry.label === label) entry.resolve(code)
      else this.waiting.push(entry)
    }
  }

  finishAll(code = 0): void {
    for (const entry of this.waiting.splice(0, this.waiting.length)) entry.resolve(code)
  }
}

/** Yield past every pending microtask so orchestration continuations run. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('typecheckPlan', () => {
  it('checks the host aggregate and generates typert concurrently, then the client aggregate', () => {
    const plan = typecheckPlan('/repo', 'pnpm')
    expect(plan.host.label).toBe('host tsc')
    expect(plan.host.args.join(' ').replaceAll('\\', '/')).toContain('node_modules/typescript/bin/tsc -b tsconfig.host.json')
    expect(plan.typert.label).toBe('typert generation')
    expect(plan.typert.args.join(' ')).toContain('generate-typert')
    expect(plan.client.label).toBe('client tsc')
    expect(plan.client.args.join(' ').replaceAll('\\', '/')).toContain('node_modules/typescript/bin/tsc -b tsconfig.client.json')
  })
})

describe('runTypecheck', () => {
  it('runs host and typert before the client and passes on full success', async () => {
    const runs = new PlannedRuns()
    const code = runTypecheck(typecheckPlan('/repo', 'pnpm'), label => runs.run(label))
    await flush()
    expect(runs.started).toEqual(['host tsc', 'typert generation'])
    runs.finishAll(0)
    await flush()
    runs.finishAll(0)
    await expect(code).resolves.toBe(0)
    expect(runs.started.filter(label => label === 'client tsc')).toHaveLength(1)
  })

  it('never starts the client when the host check fails', async () => {
    const runs = new PlannedRuns()
    const code = runTypecheck(typecheckPlan('/repo', 'pnpm'), label => runs.run(label))
    await flush()
    runs.finish('host tsc', 2)
    runs.finish('typert generation', 0)
    await expect(code).resolves.toBe(2)
    expect(runs.started).not.toContain('client tsc')
  })

  it('never starts the client when typert generation fails', async () => {
    const runs = new PlannedRuns()
    const code = runTypecheck(typecheckPlan('/repo', 'pnpm'), label => runs.run(label))
    await flush()
    runs.finish('host tsc', 0)
    runs.finish('typert generation', 1)
    await expect(code).resolves.toBe(1)
    expect(runs.started).not.toContain('client tsc')
  })

  it('propagates the client exit code', async () => {
    const runs = new PlannedRuns()
    const code = runTypecheck(typecheckPlan('/repo', 'pnpm'), label => runs.run(label))
    await flush()
    runs.finishAll(0)
    await flush()
    runs.finish('client tsc', 3)
    await expect(code).resolves.toBe(3)
  })
})
