/**
 * Product-label resolution for permission presets: built-in machine values
 * render under their locale product names (the English default when no locale
 * seat is offered), a host-customized preset keeps its own name, and a
 * host-configured kebab value falls through to the title-case transform.
 */
import { describe, expect, it } from 'vitest'
import { displayPermissionPreset, displayPresetName } from '../src/client/presentation.ts'

describe('displayPermissionPreset', () => {
  const zh: Record<string, string> = {
    'preset.readOnly': '仅可查看',
    'preset.workspaceWrite': '工作区内修改',
    'preset.fullAccess': '完全权限',
  }
  const t = (key: string): string => zh[key] ?? key

  it('renders built-in presets under the locale product name', () => {
    expect(displayPermissionPreset('read-only', 'read-only', t)).toBe('仅可查看')
    expect(displayPermissionPreset('workspace-write', 'Workspace Write', t)).toBe('工作区内修改')
    expect(displayPermissionPreset('danger-full-access', 'Full access', t)).toBe('完全权限')
  })

  it('falls back to the English product label when no locale seat is offered', () => {
    expect(displayPermissionPreset('read-only', 'read-only')).toBe('Read Only')
    expect(displayPermissionPreset('danger-full-access', 'danger-full-access')).toBe('Full access')
  })

  it('keeps a host-customized name and title-cases a configured kebab value', () => {
    expect(displayPermissionPreset('read-only', '沙箱只读', t)).toBe('沙箱只读')
    expect(displayPermissionPreset('sandbox-read', 'sandbox-read', t)).toBe('Sandbox Read')
    expect(displayPresetName('two-words-here')).toBe('Two Words Here')
  })
})
