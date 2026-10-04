/**
 * The diagnosis script shipped with the `diagnose-windows-sandbox-acl` skill is
 * a runnable artifact. Non-Windows lanes pin its two-step contract statically
 * and execute the argument-validation paths, which complete before any Win32
 * call; the scan and the repairs themselves are exercised by the Windows lane.
 *
 * The contract under test: one scan code path whose mutation branches are
 * gated by a `-Repair` switch (a default run touches no permissions, reports
 * the verdicts and planned repairs, and prints the exact `REPAIR_COMMAND`
 * follow-up), the record/verdict/backup/rollback machinery inherited from the
 * official one-run script, and refusal of the removed `-Fix`,
 * `-GrantFullControl` and `-Compact` switches.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptUrl = new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url)
const scriptPath = fileURLToPath(scriptUrl)
const script = readFileSync(scriptPath, 'utf8')
const skillBody = readFileSync(fileURLToPath(new URL('../assets/diagnose-windows-sandbox-acl/SKILL.md', import.meta.url)), 'utf8')

function pwshAvailable(): boolean {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Vitest's asymmetric factories return any; expected matchers are opaque values.
const containingObject = (value: Record<string, unknown>): unknown => expect.objectContaining(value)
const containingString = (value: string): unknown => expect.stringContaining(value)

interface ScriptRun {
  readonly code: number
  readonly output: string
}

function runPowerShell(args: readonly string[]): ScriptRun {
  try {
    const stdout = execFileSync('pwsh', ['-NoLogo', '-NonInteractive', '-NoProfile', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    return { code: 0, output: stdout }
  } catch (error) {
    if (typeof error !== 'object' || error === null) throw error
    const status = (error as { status?: unknown }).status
    if (typeof status !== 'number') throw error
    const partial = error as { stdout?: unknown; stderr?: unknown }
    return {
      code: status,
      output: `${typeof partial.stdout === 'string' ? partial.stdout : ''}${typeof partial.stderr === 'string' ? partial.stderr : ''}`,
    }
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

interface ScriptReport {
  readonly kind: string
  readonly operation: string
  readonly status: string
  readonly reason: string
  readonly details: Record<string, unknown>
}

function reports(run: ScriptRun): ScriptReport[] {
  const result = run.output.split(/\r?\n/u).filter(line => line.startsWith('REPORT '))
    .map(line => JSON.parse(line.slice('REPORT '.length)) as ScriptReport)
  expect(result.length).toBeGreaterThan(0)
  for (const entry of result) expect(entry.reason.length).toBeGreaterThan(0)
  expect(result.at(-1)).toMatchObject({ kind: 'summary', details: { exitCode: run.code } })
  return result
}

describe('diagnose-windows-sandbox-acl script contract', () => {
  it('declares the -Repair switch as the only mutation gate', () => {
    expect(script).toContain('[switch]$Repair')
    expect(script).toContain('if (-not $Repair)')
    expect(script).toContain('if ($Repair)')
    // A default run plans instead of mutating, and hands over the exact command.
    expect(script).toContain('PLANNED_GRANT')
    expect(script).toContain('PLANNED_FIX')
    expect(script).toContain('REPAIR_COMMAND')
    // The removed official switches stay removed (parameter-token form; the
    // unrelated -CompactRecord re-read switch of Get-ObjectFacts must not match).
    expect(script).not.toMatch(/-(?:Fix|GrantFullControl|Compact)\b/u)
    expect(script).not.toContain('$GrantFullControl')
    expect(script).not.toMatch(/\$Fix\b/u)
  })

  it('keeps the scan, bounding, and rollback machinery of the one-run original', () => {
    expect(script).toContain('Get-RepairRefusal')
    expect(script).toContain('grant_targets')
    expect(script).toContain('remove_package_sources')
    expect(script).toContain('subtree_scan')
    expect(script).toContain('$SCAN_LIMIT')
    expect(script).toContain('REPAIR_REFUSED')
    expect(script).toContain('GRANT_FAILED')
    expect(script).toContain('BACKUP ')
    expect(script).toContain('ROLLBACK ')
    expect(script).toContain('RECAP ')
    expect(script).toContain('restore_pending_then_stop')
    expect(script).toContain('verify_original_confined_operation')
    // Rollback walks attempted recoveries in reverse order.
    expect(script).toContain('for ($i = $recoveries.Count - 1; $i -ge 0; $i--)')
  })

  it('documents the two-step flow without any upload request', () => {
    expect(skillBody).toContain('-Repair')
    expect(skillBody).toContain('REPAIR_COMMAND')
    // Step 1 keeps -Out inside the failing workspace so the confined token can
    // write its report; step 2 places it beside the workspace.
    expect(skillBody).toContain('workspace-writable')
    expect(skillBody).toContain('完全权限')
    expect(skillBody).not.toMatch(/feedback/ui)
    expect(skillBody).toContain('run_repair_command')
  })
})

describe.skipIf(!pwshAvailable())('diagnose-windows-sandbox-acl argument validation', { timeout: 120_000 }, () => {
  it('requires -Out outside restore mode and reports the failure through the record pipeline', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-'))
    try {
      const run = runPowerShell(['-File', scriptPath, '-Path', join(scratch, 'x'), '-AllowRoot', scratch])
      expect(run.code, run.output).toBe(2)
      const entries = reports(run)
      expect(entries).toContainEqual(containingObject({
        kind: 'error',
        status: 'stopped',
        details: containingObject({ error: containingString('requires -Out') }),
      }))
      expect(run.output).toContain('RECAP ')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('requires -AllowRoot', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-'))
    try {
      const run = runPowerShell(['-File', scriptPath, '-Path', join(scratch, 'x'), '-Out', join(scratch, 'out')])
      expect(run.code, run.output).toBe(2)
      expect(reports(run)).toContainEqual(containingObject({
        kind: 'error',
        details: containingObject({ error: containingString('Every modification requires -AllowRoot') }),
      }))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('rejects -Restore with two paths and together with -Repair', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-'))
    try {
      const twoPaths = runPowerShell(['-Command',
        `& ${quote(scriptPath)} -Path @(${quote(join(scratch, 'a'))}, ${quote(join(scratch, 'b'))}) -AllowRoot ${quote(scratch)} -Restore 'record.json'; exit $LASTEXITCODE`])
      expect(twoPaths.code, twoPaths.output).toBe(2)
      expect(reports(twoPaths)).toContainEqual(containingObject({
        kind: 'error',
        details: containingObject({ error: containingString('exactly one -Path') }),
      }))

      const combined = runPowerShell(['-File', scriptPath, '-Path', join(scratch, 'a'), '-AllowRoot', scratch, '-Out', join(scratch, 'out'), '-Restore', 'record.json', '-Repair'])
      expect(combined.code, combined.output).toBe(2)
      expect(reports(combined)).toContainEqual(containingObject({
        kind: 'error',
        details: containingObject({ error: containingString('mutually exclusive') }),
      }))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it.each(['-Fix', '-GrantFullControl', '-Compact'])('rejects the removed %s switch', (flag) => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-'))
    try {
      const run = runPowerShell(['-File', scriptPath, '-Path', join(scratch, 'a'), '-AllowRoot', scratch, '-Out', join(scratch, 'out'), flag])
      expect(run.code, run.output).not.toBe(0)
      expect(run.output).not.toContain('REPORT ')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
