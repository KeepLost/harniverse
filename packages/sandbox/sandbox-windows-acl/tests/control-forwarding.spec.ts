/**
 * Control-descriptor forwarding: the runner's restricted spawn must carry the
 * inherited control pipe (fd 7) into the child CRT. Pure stub binding tables
 * — no real Win32 calls, so these run on every platform.
 */

import { describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import { win32Layout } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { inheritedControlStdio } from '../src/control-stdio.ts'
import { spawnSandboxedInherited } from '../src/spawn.ts'
import * as abi from '../src/win32-abi.ts'

const FILE_TYPE_PIPE = 3

/** The stub the control-forwarding path needs: everything succeeds, the control OS handle is distinct. */
function controlForwardingApi(
  controlHandle: bigint,
): {
  api: Win32Bindings
  startupInfo: ReturnType<typeof vi.fn>
  setHandleInformation: ReturnType<typeof vi.fn>
} {
  let std = 50n
  const startupInfo = vi.fn()
  const setHandleInformation = vi.fn(() => 1)
  const api = {
    createJobObjectW: vi.fn(() => 100n),
    setInformationJobObject: vi.fn(() => 1),
    getStdHandle: vi.fn(() => std++),
    setHandleInformation,
    getFileType: vi.fn(() => FILE_TYPE_PIPE),
    uvGetOsfhandle: vi.fn(() => controlHandle),
    createProcessAsUserW: vi.fn((
      _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
      _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, si: NativePtr, processInfo: NativePtr,
    ) => {
      startupInfo(koffi.decode(si, win32Layout().STARTUPINFOW) as { cbReserved2: number; lpReserved2: unknown })
      koffi.encode(processInfo, win32Layout().PROCESS_INFORMATION, { hProcess: 200n, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
      return 1
    }),
    assignProcessToJobObject: vi.fn(() => 1),
    resumeThread: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
  } as unknown as Win32Bindings
  return { api, startupInfo, setHandleInformation }
}

describe('inheritedControlStdio encodes the child CRT descriptor table', () => {
  const stdio = {
    stdin: 11n as NativePtr,
    stdout: 12n as NativePtr,
    stderr: 13n as NativePtr,
    control: { fileDescriptor: 7 as const, handle: 77n as NativePtr },
  }

  it('writes count, flags, and 64-bit handles with fd 7 naming the control pipe', () => {
    const api = { getFileType: vi.fn(() => FILE_TYPE_PIPE) }
    const bytes = inheritedControlStdio(api, stdio)
    expect(bytes.length).toBe(76)
    expect(bytes.readUInt32LE(0)).toBe(8)
    expect(bytes[4 + 7]).toBe(0x01 | 0x08)
    expect(bytes.readBigUInt64LE(4 + 8 + 7 * 8)).toBe(77n)
  })

  it('marks console and file handles with their CRT kinds', () => {
    const api = { getFileType: vi.fn((handle: bigint) => (handle === 11n ? 2 : handle === 12n ? 1 : FILE_TYPE_PIPE)) }
    const bytes = inheritedControlStdio(api, stdio)
    // stdin is a char device (FOPEN | FDEV); stdout is a file (FOPEN only).
    expect(bytes[4 + 0]).toBe(0x01 | 0x40)
    expect(bytes[4 + 1]).toBe(0x01)
  })

  it('rejects a control handle that is not a pipe', () => {
    const api = { getFileType: vi.fn(() => 1) }
    expect(() => inheritedControlStdio(api, stdio)).toThrow('subprocess control descriptor is not a Windows pipe')
  })
})

describe('spawnSandboxedInherited forwards the control descriptor', () => {
  const token = 1n as NativePtr

  it('marks the control handle inheritable and seeds the CRT table', () => {
    const { api, startupInfo, setHandleInformation } = controlForwardingApi(300n)
    const native = spawnSandboxedInherited(api, token, { command: 'node.exe', args: [], cwd: 'C:\\', controlFileDescriptor: 7 })
    expect(native.pid).toBe(1234)
    // stdin, stdout, stderr, then the control handle, then the four restores.
    expect(setHandleInformation).toHaveBeenCalledWith(300n, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT)
    expect(setHandleInformation).toHaveBeenCalledWith(300n, abi.HANDLE_FLAG_INHERIT, 0)
    expect(startupInfo).toHaveBeenCalledTimes(1)
    const info = startupInfo.mock.calls[0]![0] as { cbReserved2: number; lpReserved2: unknown }
    expect(info.cbReserved2).toBe(76)
    expect(info.lpReserved2).not.toBeNull()
  })

  it('throws before spawn when the control descriptor has no OS handle', () => {
    const api = {
      ...controlForwardingApi(300n).api,
      uvGetOsfhandle: vi.fn(() => null),
    } as unknown as Win32Bindings
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'node.exe', args: [], cwd: 'C:\\', controlFileDescriptor: 7 })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toContain('control fd 7')
  })

  it('throws when the resolved handle is the invalid sentinel', () => {
    const api = {
      ...controlForwardingApi(300n).api,
      uvGetOsfhandle: vi.fn(() => 0xffff_ffff_ffff_ffffn),
    } as unknown as Win32Bindings
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'node.exe', args: [], cwd: 'C:\\', controlFileDescriptor: 7 })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toContain('control fd 7')
  })
})
