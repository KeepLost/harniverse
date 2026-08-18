/** Cordis lifecycle contributions for plugin diagnostics. */

import type { Context, Fiber, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { PluginDiagnosticCheck } from '@deepseek-ai/dsh-plugin-diagnostics'
import type { PluginDiagnosticFinding } from '@deepseek-ai/dsh-plugin-diagnostics/types'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-cordis-host-runner'

/** Cordis plugin name. */
export const name = 'plugin-diagnostics-cordis'
/** Required lifecycle authority and diagnostic registry. */
export const inject = ['pluginDiagnostics', 'loader']

const FIBER_PENDING = 0 as FiberState.PENDING
const FIBER_LOADING = 1 as FiberState.LOADING
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED
const FIBER_DISPOSED = 4 as FiberState.DISPOSED

function address(id: string, name?: string): string {
  return name === undefined ? id : `${id} (${name})`
}

function transitionFinding(
  checkId: string,
  domain: 'host-loader' | 'standing-preset',
  path: string,
  fiber: Fiber,
): PluginDiagnosticFinding | undefined {
  if (fiber.state === FIBER_ACTIVE || fiber.state === FIBER_DISPOSED) return undefined
  if (fiber.state === FIBER_PENDING) {
    const missing = Object.keys(fiber.inject)
      .filter(service => fiber.ctx.get(service) === undefined)
      .sort((left, right) => left.localeCompare(right))
    return {
      checkId,
      code: domain === 'host-loader' ? 'entry-pending' : 'preset-mount-pending',
      severity: 'error',
      domain,
      path,
      message: missing.length > 0
        ? `The plugin is waiting for required services: ${missing.join(', ')}.`
        : 'The plugin remains pending without an observable missing service.',
      fixHint: 'Provide the missing service in the same isolation realm; do not restart while the dependency remains absent.',
    }
  }
  if (fiber.state === FIBER_FAILED) {
    return {
      checkId,
      code: domain === 'host-loader' ? 'entry-failed' : 'preset-mount-failed',
      severity: 'error',
      domain,
      path,
      message: 'The plugin failed during activation; failure details remain in the Host log.',
      fixHint: 'Correct the owning plugin or configuration before attempting a deliberate reload; do not retry blindly.',
    }
  }
  const phase = fiber.state === FIBER_LOADING ? 'loading' : 'unloading'
  return {
    checkId,
    code: 'entry-transitioning',
    severity: 'info',
    domain,
    path,
    message: `The plugin is ${phase}; this point-in-time transition is not classified as a failure.`,
  }
}

function hostLoaderCheck(ctx: Context): PluginDiagnosticCheck {
  const checkId = 'cordis/host-loader'
  return {
    id: checkId,
    description: 'Observe enabled Host Loader entry root fibers.',
    diagnose: () => {
      const findings: PluginDiagnosticFinding[] = []
      for (const entry of ctx.loader.entries()) {
        if (entry.options.group || entry.disabled) continue
        if (entry.fiber === undefined) {
          findings.push({
            checkId,
            code: 'entry-not-started',
            severity: 'error',
            domain: 'host-loader',
            path: address(entry.id, entry.options.name),
            message: 'The enabled Loader entry has no root Fiber.',
            fixHint: 'Verify package installation and module resolution before restarting the process.',
          })
          continue
        }
        const finding = transitionFinding(checkId, 'host-loader', address(entry.id, entry.options.name), entry.fiber)
        if (finding !== undefined) findings.push(finding)
      }
      return findings
    },
  }
}

function standingPresetCheck(ctx: Context): PluginDiagnosticCheck {
  const checkId = 'cordis/standing-presets'
  return {
    id: checkId,
    description: 'Observe live standing agent-preset root fibers.',
    diagnose: () => {
      if (ctx.get('agentPresets') === undefined) return []
      const findings: PluginDiagnosticFinding[] = []
      for (const mount of livePresetMounts()) {
        const finding = transitionFinding(checkId, 'standing-preset', `preset:${mount.presetId}`, mount.fiber)
        if (finding !== undefined) findings.push(finding)
      }
      return findings
    },
  }
}

function dynamicPackagesCheck(ctx: Context): PluginDiagnosticCheck {
  const checkId = 'cordis/dynamic-packages'
  return {
    id: checkId,
    description: 'Observe retained dynamic Cordis activation attempts.',
    diagnose: () => {
      const runner = ctx.get('dynamicCordisRunner')
      if (runner === undefined) return []
      const findings: PluginDiagnosticFinding[] = []
      for (const plugin of runner.inventory()) {
        const attempt = plugin.latestRun
        if (attempt?.status === 'failed') {
          findings.push({
            checkId,
            code: 'dynamic-run-failed',
            severity: 'error',
            domain: 'dynamic-cordis',
            path: `dynamic:${plugin.pluginId}`,
            message: attempt.error === undefined
              ? 'The latest dynamic package activation failed.'
              : `The latest dynamic package activation failed during ${attempt.error.phase}.`,
            fixHint: 'Inspect the retained attempt, define a corrected immutable package, and require a deliberate retry.',
          })
          continue
        }
        if (attempt?.status !== 'waiting') continue
        const missing = [...new Set([...attempt.host.waitingFor, ...attempt.client.waitingFor])]
          .sort((left, right) => left.localeCompare(right))
        findings.push({
          checkId,
          code: 'dynamic-run-waiting',
          severity: 'warning',
          domain: 'dynamic-cordis',
          path: `dynamic:${plugin.pluginId}`,
          message: missing.length > 0
            ? `The dynamic package is waiting for services: ${missing.join(', ')}.`
            : 'The dynamic package is waiting without an observable missing service.',
          fixHint: 'Verify the intended Host and Client providers before retrying; do not restart unrelated plugins.',
        })
      }
      return findings
    },
  }
}

/**
 * Register read-only Cordis lifecycle checks.
 * @param ctx - Host context carrying Loader state and optional preset/dynamic services.
 * @returns disposer for all three diagnostic contributions.
 */
export function apply(ctx: Context): () => void {
  const disposers = [
    ctx.pluginDiagnostics.register(hostLoaderCheck(ctx)),
    ctx.pluginDiagnostics.register(standingPresetCheck(ctx)),
    ctx.pluginDiagnostics.register(dynamicPackagesCheck(ctx)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
