/** Both Windows process owners must terminate through the OS utility without PATH lookup. */
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskkillProcessTree } from '../src/spawn.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

const environment = process.env
afterEach(() => { process.env = environment; vi.resetAllMocks() })

const owners = [
  { name: 'subprocess', terminate: (pid: number) => { taskkillProcessTree(pid) }, force: true },
  { name: 'inspector grace', terminate: (pid: number) => { createWindowsProcessInspector().signalGroup(pid, 'SIGTERM') }, force: false },
  { name: 'inspector force', terminate: (pid: number) => { createWindowsProcessInspector().signalGroup(pid, 'SIGKILL') }, force: true },
]

function systemRoot(value: string | undefined, key = 'SystemRoot'): void {
  // A plain snapshot exercises casing on every OS without mutating Windows' native env aliases.
  process.env = { ...Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== 'SYSTEMROOT')),
    [key]: value, PATH: '' }
}

describe.each(owners)('$name Windows tree termination', ({ terminate, force }) => {
  it.each(['SystemRoot', 'systemroot', 'sYsTeMrOoT'])('uses %s with an empty PATH and retains its force policy', (key) => {
    const root = 'D:\\Windows System'
    systemRoot(root, key)
    let alive = true
    vi.mocked(spawnSync).mockImplementation((file, args) => {
      // Model executable resolution with no executable in cwd or PATH.
      const found = file === win32.join(root, 'System32', 'taskkill.exe')
      if (found) {
        expect(args).toEqual(['/PID', '1234', '/T', ...(force ? ['/F'] : [])])
        alive = false
      }
      return { pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: found ? 0 : null,
        signal: null, ...found ? {} : { error: Object.assign(new Error('taskkill unavailable on PATH'), { code: 'ENOENT' }) } }
    })
    terminate(1234)
    expect(alive, 'the owned tree survives when taskkill is resolved through PATH').toBe(false)
    expect(spawnSync).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, '', 'relative-windows', '\\Windows', 'C:Windows'])('never falls back to PATH with SystemRoot=%s', (root) => {
    systemRoot(root)
    expect(() => { terminate(1234) }).not.toThrow()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('contains already-absent trees and missing utilities without retrying a bare executable', () => {
    systemRoot('C:\\Windows')
    vi.mocked(spawnSync).mockReturnValue({ pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      status: null, signal: null, error: Object.assign(new Error('unavailable'), { code: 'ENOENT' }) })
    expect(() => { terminate(1234) }).not.toThrow()
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe('C:\\Windows\\System32\\taskkill.exe')
    vi.mocked(spawnSync).mockReturnValue({ pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      status: 128, signal: null })
    expect(() => { terminate(1234) }).not.toThrow()
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('does not launch a utility for non-positive process ids', () => {
    systemRoot('C:\\Windows')
    terminate(0)
    terminate(-1)
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
