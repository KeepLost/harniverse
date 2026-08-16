/**
 * `LocalSpillStore`: the host-filesystem implementation of the
 * `@deepseek-ai/dsh-spill` storage seam. Persists a tool's oversized text to a
 * private, session-scoped file (see `./store.ts` for the traversal-safe naming
 * and exclusive owner-only write) and returns an opaque locator consumed by
 * the backend's bounded cursor reader.
 *
 * @module @deepseek-ai/dsh-spill-local
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, ReadTextSpillPage, SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { localLocator, privateRoot, readTextFile, saveTextFile } from './store.ts'

export { encodeSegment, localLocator, privateRoot, readTextFile, saveTextFile, sessionDir } from './store.ts'
export type { SavedText, SaveTextOptions } from './store.ts'

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /**
   * Root directory for spill files. Omitted uses the durable
   * `$DSH_HOME/artifacts/tool-results` location. Set it to use another durable
   * deployment-owned location.
   */
  root?: string
}

/**
 * Local-filesystem spill backend. Files land under `<root>/session-<hash>/…`
 * with unpredictable names, an exclusive owner-only (0600) write, and a private
 * (0700) root — a spilled tool result must not be readable by other local users
 * or redirectable via a planted symlink.
 */
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
  })

  /** Resolved absolute spill root (config `root`, else the private default), fixed at construction. */
  readonly root: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()
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
      retrievalHint: 'Use artifact_read with this locator to retrieve the complete text.',
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
