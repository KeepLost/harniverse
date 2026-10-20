/**
 * The user-global rules editor Service Definition (`ctx.globalRules`). The
 * file it serves — the harness home's `AGENTS.md` — is the same file the
 * `dsh-agent-instructions` loader treats as the `user-global` scope, so an
 * edit here reaches every session's baseline without any extra propagation:
 * new sessions read it on their first step and live sessions reconcile it
 * after their next file operation.
 *
 * Home resolution mirrors the loader exactly (`resolveDshHome`: explicit
 * config over `$DSH_HOME` over `~/.dsh`), and the write cap defaults to the
 * loader's per-file source cap so anything the editor accepts is guaranteed
 * loadable.
 *
 * @module @deepseek-ai/dsh-global-rules
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { GlobalRules, GlobalRulesFileView, GlobalRulesWriteResult } from './types.ts'

export type { GlobalRules, GlobalRulesFileView, GlobalRulesWriteResult } from './types.ts'

/** File name of the user-global rules scope inside the harness home. */
const RULES_FILE_NAME = 'AGENTS.md'

/**
 * Default per-file byte cap. Equals the instruction loader's
 * `DEFAULT_MAX_SOURCE_BYTES` so the editor's default accepts exactly what
 * the loader's default will read; compositions overriding one should set the
 * other to match.
 */
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576

/** Length of the content-derived freshness token (hex sha256 prefix). */
const VERSION_TOKEN_LENGTH = 32

declare module '@deepseek-ai/cordis' {
  interface Context {
    globalRules: GlobalRules
  }
}

/** User-facing provider configuration. */
export interface Config {
  /** Harness home override with the loader's precedence (`$DSH_HOME` then `~/.dsh`). */
  dshHome?: string
  /** Maximum UTF-8 bytes one write accepts; defaults to the loader's per-file cap. */
  maxSourceBytes?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
})

/**
 * Whether a filesystem error means the path is missing rather than broken.
 * ENOTDIR is absence the same way the instruction loader treats it.
 */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Derive the content freshness token: stable across rewrites of equal content. */
function versionOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, VERSION_TOKEN_LENGTH)
}

/**
 * File-backed provider for the user-global rules. Load it as a plugin and it
 * registers as `ctx.globalRules`; every method is stateless over the single
 * resolved file path.
 */
export default class GlobalRulesService extends Service implements GlobalRules {
  static Config: z<Config> = Config

  /** Absolute path of the edited rules file. */
  private readonly file: string
  /** Symbolic display path shown to users; never an absolute machine path. */
  readonly displayPath: string
  /** Maximum UTF-8 byte count one write accepts. */
  readonly maxBytes: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'globalRules')
    const home = resolveDshHome(config.dshHome)
    this.file = join(home, RULES_FILE_NAME)
    this.displayPath = `${dshHomeDisplay(home)}/${RULES_FILE_NAME}`
    this.maxBytes = config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  }

  /** @inheritdoc */
  async read(): Promise<GlobalRulesFileView> {
    let content: string
    try {
      content = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return { exists: false, content: '', version: undefined, displayPath: this.displayPath, maxBytes: this.maxBytes }
      }
      throw error
    }
    return { exists: true, content, version: versionOf(content), displayPath: this.displayPath, maxBytes: this.maxBytes }
  }

  /** @inheritdoc */
  async write(content: string, expectedVersion?: string): Promise<GlobalRulesWriteResult> {
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) return { ok: false, reason: 'too-large' }
    if (expectedVersion !== undefined) {
      const current = await this.loadVersion()
      if (current !== expectedVersion) return { ok: false, reason: 'conflict', version: current }
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, content, 'utf8')
    return { ok: true, version: versionOf(content) }
  }

  /**
   * Content token of the file as it stands, for conflict detection.
   * @returns the token, or undefined when the file does not exist.
   */
  private async loadVersion(): Promise<string | undefined> {
    let content: string
    try {
      content = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if (isMissingPathError(error)) return undefined
      throw error
    }
    return versionOf(content)
  }
}
