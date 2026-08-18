/** Read-only plugin diagnostic check registry. @module @deepseek-ai/dsh-plugin-diagnostics */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  PluginDiagnosticFinding,
  PluginDiagnosticReport,
  PluginDiagnosticSeverity,
} from './types.ts'

export type * from './types.ts'

/** Effect-owned read-only diagnostic contribution. */
export interface PluginDiagnosticCheck {
  readonly id: string
  readonly description: string
  /**
   * Observe current owner state without mutating it.
   * @param signal - caller cancellation checked before the contribution starts.
   * @returns current findings; an empty list means this check found no problem.
   */
  diagnose(signal?: AbortSignal):
    | readonly PluginDiagnosticFinding[]
    | Promise<readonly PluginDiagnosticFinding[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginDiagnostics: PluginDiagnostics
  }
}

const STABLE_ID = /^[a-z0-9](?:[a-z0-9./-]*[a-z0-9])?$/
const SEVERITY_RANK: Record<PluginDiagnosticSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
}

function assertStableId(value: string, field: string): void {
  if (!STABLE_ID.test(value)) {
    throw new Error(`plugin diagnostics: ${field} must be a stable lowercase id`)
  }
}

function copyFinding(checkId: string, finding: PluginDiagnosticFinding): PluginDiagnosticFinding {
  if (finding.checkId !== checkId) {
    throw new Error(`plugin diagnostics: check ${JSON.stringify(checkId)} returned another checkId`)
  }
  assertStableId(finding.code, 'finding code')
  if (finding.message.length === 0 || finding.message.trim() !== finding.message) {
    throw new Error('plugin diagnostics: finding message must be non-blank and trimmed')
  }
  return {
    checkId: finding.checkId,
    code: finding.code,
    severity: finding.severity,
    domain: finding.domain,
    message: finding.message,
    ...finding.path === undefined ? {} : { path: finding.path },
    ...finding.fixHint === undefined ? {} : { fixHint: finding.fixHint },
  }
}

function compareFindings(left: PluginDiagnosticFinding, right: PluginDiagnosticFinding): number {
  const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
  if (severity !== 0) return severity
  const check = left.checkId.localeCompare(right.checkId)
  if (check !== 0) return check
  const path = (left.path ?? '').localeCompare(right.path ?? '')
  return path !== 0 ? path : left.code.localeCompare(right.code)
}

/** Registry and coordinator for read-only plugin diagnostics. */
export class PluginDiagnostics extends Service {
  private readonly checks = new Map<string, PluginDiagnosticCheck>()
  private readonly ownerCtx: Context

  /**
   * Create the process-local diagnostics registry.
   * @param ctx - Cordis context that owns diagnostic execution and logging.
   */
  constructor(ctx: Context) {
    super(ctx, 'pluginDiagnostics')
    this.ownerCtx = ctx
  }

  /**
   * Register one read-only check on the calling plugin fiber.
   * @param check - stable identity, description, and observation callback.
   * @returns the exact disposer that removes the contribution.
   */
  register(check: PluginDiagnosticCheck): () => void {
    assertStableId(check.id, 'check id')
    if (check.description.length === 0 || check.description.trim() !== check.description) {
      throw new Error('plugin diagnostics: description must be non-blank and trimmed')
    }
    if (this.checks.has(check.id)) {
      throw new Error(`plugin diagnostics: check ${JSON.stringify(check.id)} is already registered`)
    }
    const checks = this.checks
    const dispose = this.ctx.effect(() => {
      checks.set(check.id, check)
      return () => { checks.delete(check.id) }
    }, `pluginDiagnostics.register(${JSON.stringify(check.id)})`)
    return () => { void dispose() }
  }

  /**
   * Run a snapshot of registered checks sequentially and contain check failures.
   * No repair callback or mutation capability exists on this service.
   * @param signal - optional cancellation checked before each contribution.
   * @returns sorted point-in-time findings.
   */
  async diagnose(signal?: AbortSignal): Promise<PluginDiagnosticReport> {
    const checks = [...this.checks.values()]
    const findings: PluginDiagnosticFinding[] = []
    for (const check of checks) {
      signal?.throwIfAborted()
      try {
        const current = await check.diagnose(signal)
        findings.push(...current.map(finding => copyFinding(check.id, finding)))
      } catch (error) {
        this.ownerCtx.logger.error(`plugin diagnostic check ${check.id} failed`, error)
        findings.push({
          checkId: check.id,
          code: 'check-failed',
          severity: 'error',
          domain: 'diagnostic-check',
          message: 'The diagnostic check failed; inspect the Host log before trusting a clean report.',
          path: check.id,
          fixHint: 'Correct the diagnostic check itself; do not change the observed plugin based on this failed check.',
        })
      }
    }
    findings.sort(compareFindings)
    return { observedAt: Date.now(), checksRun: checks.length, findings }
  }
}

export default PluginDiagnostics
