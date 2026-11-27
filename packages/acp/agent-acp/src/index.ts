/**
 * ACP mode: an agent whose turns are turns of an external Agent Client Protocol
 * agent. The row registers the step driver for every agent whose scope
 * descends from its own, so a preset names ACP mode by composing this row and
 * nothing else. This plugin uses named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-agent-acp
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AcpProtocol } from '@deepseek-ai/dsh-acp-client'
import type {} from '@deepseek-ai/dsh-subprocess'
import { AcpStepDriver, permissionAnswerer, type AcpPermissionMode } from './driver.ts'

export const name = 'agent-acp'
export const inject = ['agents', 'subprocess']

/** Config: how to start the external agent and how to answer its permission requests. */
export interface Config {
  /** Executable that serves the external ACP agent over stdio. */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Environment variables added on top of the subprocess seam's scrubbed parent environment. */
  env: Record<string, string>
  /**
   * Working directory of the external process and of its session. Must be
   * non-empty; a relative path resolves against the harness launch directory
   * at load. When omitted, each session's own workspace is used, and starting
   * one from a session that has no workspace fails.
   */
  cwd?: string
  /** ACP version requested at the handshake: `1`, the stable protocol, or `2`, the Preview protocol with a v1 fallback. */
  protocol?: AcpProtocol
  /**
   * How to answer the external agent's permission requests: `ask` (default)
   * routes each one through the approval seam and fails closed without an
   * answerer; `allow` takes the agent's first allow option; `reject` declines
   * every request.
   */
  permission: AcpPermissionMode
}

export const Config: z<Config> = z.object({
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  cwd: z.string(),
  protocol: z.number().default(1),
  permission: z.union(['ask', 'allow', 'reject'] as const).default('ask'),
}) as z<Config>

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/**
 * Reject a protocol version this client cannot request.
 * @param protocol - the configured value.
 */
function assertProtocol(protocol: number): void {
  if (protocol !== 1 && protocol !== 2) {
    throw new Error(`agent-acp: protocol must be 1 or 2, got ${protocol}`)
  }
}

/**
 * Resolve the configured working directory at load: a relative path belongs to
 * the harness launch directory, and an empty one is a misconfiguration.
 * @param cwd - the configured value, when set.
 * @returns the absolute working directory, or `undefined` to use each session's own.
 */
function resolveCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (cwd === '') {
    throw new Error('agent-acp: config cwd must not be empty — omit the key to use each session\'s workspace')
  }
  return resolve(cwd)
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertProtocol(resolved.protocol)
  const subprocess = ctx.subprocess
  const cwd = resolveCwd(resolved.cwd)
  ctx.agents.registerDriver(host => new AcpStepDriver(host, {
    definition: {
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      protocol: resolved.protocol,
    },
    cwd,
    spawn: spec => subprocess.spawn(spec),
  }, permissionAnswerer(resolved.permission, host)))
}
