/**
 * Types for the environment-facts prompt section. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-environment/types
 */

/** Process-stable facts about the machine an agent works on. */
export interface EnvironmentFacts {
  /** Coarse operating-system label: `Linux`, `macOS`, `Windows`, or the raw platform identifier. */
  readonly os: string
  /** Shell dialect the harness executes commands through on this platform: `bash`, `zsh`, or `PowerShell`. */
  readonly shell: string
  /** Command userland family; absent where the distinction does not apply, as on Windows. */
  readonly userland?: string
  /** Label of the working machine the session's commands run on. */
  readonly machine: string
}
