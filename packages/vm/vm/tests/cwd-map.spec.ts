import { describe, expect, it } from 'vitest'
import { WORLD_WORKSPACE_ROOT, hostWorkspaceRootFromEnv, mapSessionCwdToWorld } from '../src/cwd-map.ts'

describe('hostWorkspaceRootFromEnv', () => {
  it('reads a trimmed root and rejects blank or absent values', () => {
    expect(hostWorkspaceRootFromEnv({ DSH_VM_HOST_WORKSPACE_ROOT: '/host/ws ' })).toBe('/host/ws')
    expect(hostWorkspaceRootFromEnv({ DSH_VM_HOST_WORKSPACE_ROOT: '   ' })).toBeUndefined()
    expect(hostWorkspaceRootFromEnv({})).toBeUndefined()
  })
})

describe('mapSessionCwdToWorld', () => {
  it('maps the anchor itself and nested cwds into the world workspace', () => {
    expect(mapSessionCwdToWorld('/host/ws', '/host/ws')).toEqual({ kind: 'world', path: WORLD_WORKSPACE_ROOT })
    expect(mapSessionCwdToWorld('/host/ws/sub/../a', '/host/ws')).toEqual({ kind: 'world', path: '/workspace/a' })
  })

  it('does not match a sibling sharing the anchor spelling', () => {
    expect(mapSessionCwdToWorld('/host/ws-other', '/host/ws')).toEqual({ kind: 'foreign', cwd: '/host/ws-other', hostRoot: '/host/ws' })
  })

  it('passes world-absolute cwds through and reports foreign host paths', () => {
    expect(mapSessionCwdToWorld('/workspace/x', '/host/ws')).toEqual({ kind: 'world', path: '/workspace/x' })
    expect(mapSessionCwdToWorld('/tmp/build', '/host/ws')).toEqual({ kind: 'foreign', cwd: '/tmp/build', hostRoot: '/host/ws' })
  })

  it('keeps every cwd untouched without an anchor', () => {
    expect(mapSessionCwdToWorld('/anything/else', undefined)).toEqual({ kind: 'world', path: '/anything/else' })
  })
})
