/**
 * Runtime network-proxy settings for the DeepSeek Harness: one global proxy
 * (`off` / `system` / `manual`) applied without a restart through the
 * `dsh-http-proxy` transport seam, so model calls, web search and fetch, HTTP
 * MCP, and plain `fetch()` callers all follow it the moment the settings
 * document changes.
 *
 * - `off` restores the launch environment's policy exactly.
 * - `manual` routes everything through one operator-entered URL with an
 *   operator-entered bypass list; an empty URL is the deliberate direct route.
 * - `system` resolves the launch snapshot's HTTP(S) variables first, then the
 *   platform setting (Windows Internet Settings, macOS scutil), re-polled
 *   every 30 seconds while active; nothing found falls back to launch with a
 *   warning.
 *
 * Per-provider routing is deliberately absent: a provider that needs its own
 * route takes it in its own base URL.
 * @module @deepseek-ai/dsh-network-proxy
 */

import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  policyFromManual,
  setProxyOverride,
  type ProxyPolicy,
} from '@deepseek-ai/dsh-http-proxy'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { detectSystemProxy, type DetectionResult } from './detect.ts'

/** Stored network-proxy settings; every field is optional over the schema defaults. */
export interface NetworkProxySettings {
  /** Which route the process-wide policy takes. */
  mode?: 'off' | 'system' | 'manual'
  /** Manual-mode proxy URL; empty is the deliberate direct route. */
  url?: string
  /** Operator-entered bypass entries, merged with the loopback floor. */
  noProxy?: string[]
}

/** Stored network-proxy settings schema. */
export const Config: z<NetworkProxySettings> = z.object({
  mode: z.union([z.const('off'), z.const('system'), z.const('manual')]),
  url: z.string(),
  noProxy: z.array(z.string()),
})

/** Settings namespace the web Settings page edits; changes apply to the next request. */
export const NETWORK_PROXY_SETTINGS_NAMESPACE = settingsNamespace('network-proxy')

/** Resolved defaults applied under the user layer. */
const BASE: NetworkProxySettings = { mode: 'off', url: '', noProxy: [] }

/** Seconds between system-proxy re-polls while `system` mode is active. */
const SYSTEM_POLL_SECONDS = 30

/** One applied decision: what to install and what to warn about. */
export interface ProxyDecision {
  /** The policy to override with; `null` restores the launch policy. */
  readonly override: ProxyPolicy | null
  /** Operator-facing warning sentences, already credential-free. */
  readonly warnings: readonly string[]
}

/**
 * Decide the override for one settings state — pure, so the plugin body stays
 * thin. `manual` with an unusable URL and `system` with nothing detected both
 * fall back to the launch policy with a warning, never to a silent direct
 * route the operator did not choose.
 *
 * @param settings - the resolved settings (mode, url, noProxy).
 * @param detection - the latest system detection, when `system` already ran one.
 * @returns the override to install and the warnings to log.
 */
export function resolveProxyDecision(
  settings: NetworkProxySettings,
  detection?: DetectionResult,
): ProxyDecision {
  const mode = settings.mode ?? 'off'
  if (mode === 'off') return { override: null, warnings: [] }
  if (mode === 'manual') {
    const resolution = policyFromManual(settings.url ?? '', settings.noProxy ?? [])
    if (resolution.diagnostics.length > 0) {
      return {
        override: null,
        warnings: [
          ...resolution.diagnostics.map(diagnostic => diagnostic.message),
          'keeping the launch proxy settings',
        ],
      }
    }
    return { override: resolution.policy, warnings: [] }
  }
  if (detection === undefined || detection.source === 'none') {
    return {
      override: null,
      warnings: ['no usable system proxy found; keeping the launch proxy settings'],
    }
  }
  const resolution = policyFromManual(detection.url ?? '', settings.noProxy ?? [])
  if (resolution.diagnostics.length > 0) {
    return {
      override: null,
      warnings: [...resolution.diagnostics.map(diagnostic => diagnostic.message), 'keeping the launch proxy settings'],
    }
  }
  return { override: resolution.policy, warnings: [] }
}

/** Run one platform command for detection; a missing or failing command reads as no proxy. */
async function runCommand(command: string, args: readonly string[]): Promise<{ stdout: string } | undefined> {
  try {
    const { stdout } = await promisify(execFile)(command, args as string[], {
      windowsHide: true,
      timeout: 5000,
    })
    return { stdout }
  } catch {
    return undefined
  }
}

/** Cordis plugin name. */
export const name = 'network-proxy'
/** The settings provider owns persistence and hot reload; this plugin follows each change. */
export const inject = ['settings']

/**
 * Register the network-proxy settings namespace and follow every committed
 * change, applying the resolved policy to the transport seam immediately.
 * @param ctx - host context carrying the settings provider.
 * @param config - composition `base` layer over the schema defaults.
 */
export function apply(ctx: Context, config?: NetworkProxySettings): void {
  const composition: NetworkProxySettings = { ...BASE, ...config }
  // Replaced by installSettingsSection with the resolved-document reader before any read;
  // the composition value only ever serves as the register call's entry argument.
  let current!: () => NetworkProxySettings
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let applyChain: Promise<void> = Promise.resolve()

  const stopPolling = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  const detect = async (): Promise<DetectionResult> => await detectSystemProxy({
    platform: process.platform,
    env: launchEnvironmentOf(ctx),
    run: runCommand,
  })

  const decide = async (): Promise<void> => {
    const settings = current()
    const detection = settings.mode === 'system' ? await detect() : undefined
    const decision = resolveProxyDecision(settings, detection)
    for (const warning of decision.warnings) ctx.logger.warn(warning)
    await setProxyOverride(decision.override)
  }

  /** Serialize applications: a poll and a committed change must never interleave installs. */
  const reapply = (): void => {
    applyChain = applyChain.then(() => decide()).catch(
      /* v8 ignore next 3 -- decide() resolves unless a consumer throws; the chain must still swallow. */
      (error: unknown) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      },
    )
  }

  installSettingsSection(ctx, NETWORK_PROXY_SETTINGS_NAMESPACE, Config, composition, {
    setSource: (source) => { current = source },
    onChange: () => {
      stopPolling()
      if (current().mode === 'system') {
        pollTimer = setInterval(reapply, SYSTEM_POLL_SECONDS * 1000)
        void delay(0)
      }
      reapply()
    },
  })

  ctx.effect(() => () => {
    stopPolling()
    /* v8 ignore next -- setProxyOverride(null) cannot reject; the swallow only guards the chain shape. */
    applyChain = applyChain.then(() => setProxyOverride(null)).catch(() => {})
  }, 'network-proxy: follow the settings document')
}
