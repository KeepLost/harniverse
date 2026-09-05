/**
 * `LocalSpillStore`: the host-filesystem implementation of the
 * `@deepseek-ai/dsh-spill` storage seam. Persists a tool's oversized text to a
 * private, session-scoped file (see `./store.ts` for the traversal-safe naming
 * and exclusive owner-only write) and returns an opaque locator consumed by
 * the backend's bounded cursor reader. After activation it runs one
 * best-effort startup sweep that reclaims spill files older than
 * `cleanupPeriodDays`.
 *
 * @module @deepseek-ai/dsh-spill-local
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, ReadTextSpillPage, SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { sweepSpillRoot } from './cleanup.ts'
import type { WarnFn } from './cleanup.ts'
import { localLocator, privateRoot, readTextFile, saveTextFile } from './store.ts'

export { sweepSpillRoot } from './cleanup.ts'
export type { SweepOptions, WarnFn } from './cleanup.ts'
export { encodeSegment, isErrno, isPrivateDirectory, localLocator, privateRoot, readTextFile, saveTextFile, sessionDir } from './store.ts'
export type { SavedText, SaveTextOptions } from './store.ts'

/** Milliseconds in one day — converts the `cleanupPeriodDays` config to the sweep cutoff. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /**
   * Root directory for spill files. Omitted uses the durable
   * `$DSH_HOME/artifacts/tool-results` location. Set it to use another durable
   * deployment-owned location.
   */
  root?: string
  /**
   * Age in days after which a spill file is eligible for the one-shot startup
   * cleanup sweep. Defaults to `30`; `0` disables the sweep entirely. A file
   * whose `mtime` is strictly older than the cutoff is deleted and a session
   * directory left empty is pruned; fresh files, symlinks, and unrelated
   * entries are left untouched, and the root itself is never removed.
   * Retention is deliberate — a resumed or forked session may still reference
   * an older locator until it ages out.
   */
  cleanupPeriodDays?: number
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'root'>> & Pick<Config, 'root'>

/**
 * Local-filesystem spill backend. Files land under `<root>/session-<hash>/…`
 * with unpredictable names, an exclusive owner-only (0600) write, and a private
 * (0700) root — a spilled tool result must not be readable by other local users
 * or redirectable via a planted symlink.
 *
 * After activation it launches ONE best-effort cleanup sweep (see
 * {@link cleanupPeriodDays}) that reclaims expired spill files without delaying
 * service availability; the sweep is owned by the plugin fiber and awaited
 * during disposal, so a fiber unload never returns before it quiesces.
 */
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
    cleanupPeriodDays: z.number().step(1).min(0).default(30),
  })

  /** Resolved absolute spill root (config `root`, else the private default), fixed at construction. */
  readonly root: string

  /** Validated config (schemastery applied the `cleanupPeriodDays` default before construction). */
  readonly config: ResolvedConfig

  /**
   * The in-flight (or settled) startup cleanup sweep. Held so disposal can await
   * it; `undefined` when cleanup is disabled (`cleanupPeriodDays === 0`).
   */
  private cleanup: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery (static Config) has already filled `cleanupPeriodDays`; the
    // cast records that runtime fact for exactOptionalPropertyTypes.
    this.config = config as ResolvedConfig
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()

    // One best-effort startup sweep, owned by the fiber. The generator body
    // runs at activation but does NOT await the sweep — it launches it and
    // yields an async disposer that awaits the SAME promise, so service
    // availability is never delayed yet a fiber unload reaches quiescence (no
    // sweep I/O outlives the fiber). Disabled (`cleanupPeriodDays === 0`)
    // yields a no-op disposer.
    ctx.effect(function* (this: LocalSpillStore) {
      if (this.config.cleanupPeriodDays > 0) {
        const warn: WarnFn = (message) => { this.ctx.logger.warn(message) }
        this.cleanup = this.runCleanup(warn)
      }
      yield async () => { await this.cleanup }
    }.bind(this), 'spill-local cleanup sweep')
  }

  /**
   * Run the one-shot cleanup: sweep the active root at the age cutoff.
   * Best-effort — {@link sweepSpillRoot} contains every filesystem failure, so
   * this never rejects and cannot fail activation or a concurrent spill write.
   * A test overrides this to hold the sweep open across a disposal for the
   * quiescence check; it is a test seam, not a deployment knob.
   *
   * @param warn - sink for a contained filesystem failure.
   * @returns Resolves when the sweep finishes (never rejects).
   */
  protected async runCleanup(warn: WarnFn): Promise<void> {
    const cutoffMs = Date.now() - this.config.cleanupPeriodDays * MS_PER_DAY
    await sweepSpillRoot({ root: this.root, cutoffMs, warn })
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const saved = await saveTextFile({
      signal: input.signal,
      root: this.root,
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return {
      locator: SpillLocator(localLocator(this.root, saved.path)),
      bytes: saved.bytes,
    }
  }

  async readText(input: ReadTextSpill): Promise<ReadTextSpillPage> {
    return readTextFile({
      signal: input.signal,
      root: this.root,
      locator: input.locator,
      ...input.cursor !== undefined ? { cursor: input.cursor } : {},
      maxChars: input.maxChars,
    })
  }
}

export default LocalSpillStore
