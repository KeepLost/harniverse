import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildQemuArgv, buildWrappedArgv, defaultAssetsDir, findPackageRoot, parseQemuVersion, resolveAccel, resolveWrapPath } from '../src/qemu.ts'
import { probeWorld } from '../src/index.ts'

const plan = buildQemuArgv({
  qemuBin: 'qemu-system-x86_64',
  accel: 'tcg',
  memoryMiB: 256,
  cpus: 2,
  kernelPath: '/assets/vmlinuz-virt',
  initrdPath: '/assets/initramfs.cpio.gz',
  controlSocketPath: '/run/ctl.sock',
  consoleLogPath: '/run/console.log',
})

describe('vm-qemu-local acceleration resolution', () => {
  it('auto prefers KVM when /dev/kvm is writable', () => {
    expect(resolveAccel(true, 'auto')).toBe('kvm')
  })

  it('auto falls back to TCG without a writable /dev/kvm', () => {
    expect(resolveAccel(false, 'auto')).toBe('tcg')
  })

  it('explicit modes win over host state', () => {
    expect(resolveAccel(false, 'kvm')).toBe('kvm')
    expect(resolveAccel(true, 'tcg')).toBe('tcg')
  })
})

describe('vm-qemu-local command-line planning', () => {
  it('executes the requested binary as argv[0] on the pc machine with no legacy defaults', () => {
    expect(plan[0]).toBe('qemu-system-x86_64')
    expect(plan).toContain('-M')
    expect(plan).toContain('pc')
    expect(plan).toContain('-nodefaults')
    expect(plan).toContain('-no-reboot')
  })

  it('carries the planned memory, cpus, kernel, and initrd', () => {
    expect(plan).toContain('-m')
    expect(plan).toContain('256')
    expect(plan).toContain('-smp')
    expect(plan).toContain('2')
    expect(plan).toContain('-kernel')
    expect(plan).toContain('/assets/vmlinuz-virt')
    expect(plan).toContain('-initrd')
    expect(plan).toContain('/assets/initramfs.cpio.gz')
  })

  it('boots the guest agent as PID 1 on the serial console', () => {
    const appendIndex = plan.indexOf('-append')
    expect(plan[appendIndex + 1]).toBe('console=ttyS0 rdinit=/init loglevel=3 panic=-1')
  })

  it('logs the console on ttyS0 and carries control on a ttyS1 unix socket', () => {
    expect(plan).toContain('-serial')
    expect(plan).toContain('file:/run/console.log')
    expect(plan.join(' ')).toContain('unix:/run/ctl.sock,server=on,wait=off')
    expect(plan.filter(argument => argument === '-serial')).toHaveLength(2)
  })

  it('never emits a network device argument', () => {
    const networkArguments = plan.filter(argument => argument.startsWith('-net') || argument.startsWith('-nic'))
    expect(networkArguments).toEqual([])
  })

  it('picks the guest CPU model per acceleration mode', () => {
    const kvmPlan = buildQemuArgv({
      qemuBin: 'qemu-system-x86_64',
      accel: 'kvm',
      memoryMiB: 256,
      cpus: 2,
      kernelPath: '/assets/vmlinuz-virt',
      initrdPath: '/assets/initramfs.cpio.gz',
      controlSocketPath: '/run/ctl.sock',
      consoleLogPath: '/run/console.log',
    })
    expect(kvmPlan).toContain('host')
    expect(plan).toContain('max')
  })
})

describe('vm-qemu-local environment probing', () => {
  it('parses the version line of qemu-system-x86_64 --version', () => {
    expect(parseQemuVersion('QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)\nCopyright')).toBe('8.2.2')
  })

  it('reports no version for unrelated output', () => {
    expect(parseQemuVersion('v24.0.0\n')).toBeUndefined()
  })

  it('locates the package root from inside src', () => {
    const expected = findPackageRoot(join(import.meta.dirname, '..'))
    expect(findPackageRoot(defaultAssetsDir())).toBe(expected)
    expect(findPackageRoot(join(expected, 'src'))).toBe(expected)
  })

  it('skips an unreadable manifest and gives up above the filesystem root', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-vm-rootwalk-'))
    writeFileSync(join(base, 'package.json'), 'this is not json')
    expect(() => findPackageRoot(base)).toThrow(/no package root found/)
  })

  it('defaults the assets directory under the package cache', () => {
    expect(defaultAssetsDir().endsWith(join('.cache', 'assets'))).toBe(true)
  })

  it('reports a missing binary and missing assets without throwing', () => {
    const emptyAssets = mkdtempSync(join(tmpdir(), 'dsh-vm-probe-'))
    const probe = probeWorld({ qemuBin: '/nonexistent-qemu-bin', assetsDir: emptyAssets })
    expect(probe.qemuVersion).toBeUndefined()
    expect(probe.assetsReady).toBe(false)
    expect(probe.accel).toBe('tcg')
  })

  it('sees staged assets as ready', () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'dsh-vm-probe-'))
    writeFileSync(join(assetsDir, 'vmlinuz-virt'), 'kernel')
    writeFileSync(join(assetsDir, 'initramfs.cpio.gz'), 'initrd')
    expect(probeWorld({ qemuBin: '/nonexistent-qemu-bin', assetsDir }).assetsReady).toBe(true)
  })

  it('defaults the binary and assets directory when no options are given', () => {
    const probe = probeWorld()
    expect(probe.qemuBin).toBe('qemu-system-x86_64')
    expect(probe.assetsDir).toBe(defaultAssetsDir())
    expect(['tcg', 'kvm']).toContain(probe.accel)
    expect(typeof probe.qemuVersion).toBe(probe.qemuVersion === undefined ? 'undefined' : 'string')
    expect(typeof probe.assetsReady).toBe('boolean')
  })

  it('reports the sandbox wrapper as staged only on linux with an executable binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-wrap-'))
    const wrap = join(dir, 'qemu-wrap')
    expect(resolveWrapPath(dir, 'linux')).toBeUndefined()
    writeFileSync(wrap, '#!/bin/sh\ntrue\n')
    expect(resolveWrapPath(dir, 'darwin')).toBeUndefined()
    // win32 maps X_OK to an existence check, so the executable-bit legs need
    // a POSIX host; the Linux and macOS lanes own them.
    if (process.platform === 'win32') return
    chmodSync(wrap, 0o755)
    expect(resolveWrapPath(dir, 'linux')).toBe(wrap)
    chmodSync(wrap, 0o644)
    expect(resolveWrapPath(dir, 'linux')).toBeUndefined()
  })

  it('plans a supervised command line around the wrapper and one scratch directory', () => {
    expect(buildWrappedArgv('/opt/qemu-wrap', '/run/scratch', ['qemu-system-x86_64', '-M', 'pc']))
      .toEqual(['/opt/qemu-wrap', '--scratch', '/run/scratch', '--', 'qemu-system-x86_64', '-M', 'pc'])
  })

  it('parses a version from a binary that runs and prints one', () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-fakeqemu-'))
    const script = join(dir, 'fake-qemu')
    writeFileSync(script, '#!/bin/sh\necho "QEMU emulator version 9.9.9 (fake)"\n')
    chmodSync(script, 0o755)
    expect(probeWorld({ qemuBin: script }).qemuVersion).toBe('9.9.9')
  })
})
