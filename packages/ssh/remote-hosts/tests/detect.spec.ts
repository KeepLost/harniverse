import { expect, it } from 'vitest'
import { detect } from '../src/detect.ts'
import { detectCommand } from '../src/platform.ts'

it('maps a POSIX probe answer onto a deployable target', () => {
  expect(detect('Linux\nx86_64\n')).toEqual({ platform: 'linux', architecture: 'x64' })
  expect(detect('Darwin\naarch64\n')).toEqual({ platform: 'darwin', architecture: 'arm64' })
})

it('maps a Windows probe answer onto a deployable target', () => {
  expect(detect('Win32NT Windows\r\nAMD64\r\n')).toEqual({ platform: 'win32', architecture: 'x64' })
  expect(detect('Windows ARM64\r\n')).toEqual({ platform: 'win32', architecture: 'arm64' })
  // A Windows POSIX shell names the same family with its own suffix.
  expect(detect('MINGW64_NT-10.0-22631\r\nx86_64\r\n')).toEqual({ platform: 'win32', architecture: 'x64' })
  expect(detect('CYGWIN_NT-10.0 ARM64\r\n')).toEqual({ platform: 'win32', architecture: 'arm64' })
})

it('reads a probe answer whose tokens appear in either order', () => {
  // `ProcessArchitecture` precedes the platform ordinal in some shells.
  expect(detect('AMD64 Win32NT\r\n')).toEqual({ platform: 'win32', architecture: 'x64' })
  expect(detect('ARM64 Windows\r\n')).toEqual({ platform: 'win32', architecture: 'arm64' })
})

it('rejects a probe answer that names no deployable target', () => {
  expect(() => detect('Linux\n')).toThrow('UNSUPPORTED_REMOTE_PLATFORM')
  expect(() => detect('SunOS\nsparc\n')).toThrow('UNSUPPORTED_REMOTE_PLATFORM')
  expect(() => detect('')).toThrow('UNSUPPORTED_REMOTE_PLATFORM')
})

it('asks for a POSIX answer before falling back to a Windows shell', () => {
  const command = detectCommand()
  expect(command.indexOf('uname -s')).toBeLessThan(command.indexOf('powershell.exe'))
  expect(command).toContain('2>/dev/null')
})
