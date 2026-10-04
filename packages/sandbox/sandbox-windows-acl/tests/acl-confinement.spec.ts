/**
 * Enrolled-workspace confinement tests with stub binding tables (the
 * failure-paths.spec.ts pattern): the confined grant applies the capability
 * ACE, the ambient-delete deny, and the Low mandatory label in one merge; the
 * legacy (unenrolled) grant stays byte-identical DACL-only; the idempotent
 * skip requires the exact grant, deny, AND label; the revoke keeps the shared
 * label while a foreign grant remains and clears it otherwise. Pure stubs —
 * no real Win32 calls, so these run on every platform; the real-FFI
 * round-trip rides the Windows CI lanes.
 */

import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import { grantWrite, revokeWrite } from '../src/acl.ts'
import { AclWriteGrant } from '../src/index.ts'
import { allocBytes, ptrAddress } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')

/** One subauthority-free SID (revision@0, count@1, identifierAuthority@2) — fully inline within an ACE's 8 SID bytes. */
function craftSid(authority: number[]): NativePtr {
  const sid = allocBytes(8)
  koffi.encode(sid, 'uint8', 1) // revision
  koffi.encode(sid, 1, 'uint8', 0) // subAuthorityCount: no subauthorities
  authority.forEach((byte, index) => {
    koffi.encode(sid, 2 + index, 'uint8', byte)
  })
  return sid
}

/** One ACE spec for {@link craftAcl}: the trustee SID it names, plus type, flags, and mask. */
interface AceSpec {
  sid: NativePtr
  type: number
  flags: number
  mask: number
}

/**
 * One in-memory ACL: header (AclRevision@0, AclSize@2, AceCount@4) then the
 * given ACEs (AceType@0, AceFlags@1, AceSize@2, Mask@4, inline 8-byte SID@8
 * copied from each ACE's own trustee).
 */
function craftAcl(aces: readonly AceSpec[]): NativePtr {
  const acl = allocBytes(8 + aces.length * 16)
  koffi.encode(acl, 'uint8', 2) // AclRevision
  koffi.encode(acl, 2, 'uint16', 8 + aces.length * 16) // AclSize
  koffi.encode(acl, 4, 'uint16', aces.length) // AceCount
  aces.forEach((ace, index) => {
    const offset = 8 + index * 16
    koffi.encode(acl, offset + 0, 'uint8', ace.type)
    koffi.encode(acl, offset + 1, 'uint8', ace.flags)
    koffi.encode(acl, offset + 2, 'uint16', 16) // AceSize: header + mask + inline 8-byte SID
    koffi.encode(acl, offset + 4, 'uint32', ace.mask)
    for (let byte = 0; byte < 8; byte++) {
      koffi.encode(acl, offset + 8 + byte, 'uint8', koffi.decode(ace.sid, byte, 'uint8') as number)
    }
  })
  return acl
}

/** One capability grant ACE: OI|CI allow of GRANT_MASK naming `sid`. */
function grantAce(sid: NativePtr): AceSpec {
  return { sid, type: abi.ACCESS_ALLOWED_ACE_TYPE, flags: abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, mask: abi.GRANT_MASK }
}

/** The label ACL the exact-label skip checks for: one SYSTEM_MANDATORY_LABEL_ACE naming `sid` no-write-up. */
function craftLabelAcl(sid: NativePtr): NativePtr {
  return craftAcl([{
    sid,
    type: abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    flags: abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    mask: abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
  }])
}

interface ApplyCall {
  information: number
  sacl: NativePtr | null
}

interface MergeCall {
  count: number
  modes: number[]
  masks: number[]
  inheritances: number[]
  trustees: bigint[]
}

/** The confinement stub: DACL/label content is per-test; every call succeeds until overridden. */
function confinementApi(options: {
  oldAcl: NativePtr | null
  labelAcl: NativePtr | null
  overrides?: Record<string, unknown>
}): {
  api: Win32Bindings
  applies: ApplyCall[]
  merges: MergeCall[]
  labelBuilds: { count: number }
} {
  const applies: ApplyCall[] = []
  const merges: MergeCall[] = []
  const labelBuilds = { count: 0 }
  let nextPtr = 100n
  const api = {
    getTempPathW: vi.fn((_length: number, buffer: Buffer) => {
      const temp = tmpdir().replace(/[\\/]$/u, '')
      buffer.write(temp, 'utf16le')
      return temp.length
    }),
    createFileW: vi.fn(() => 7n),
    lockFileEx: vi.fn(() => 1),
    unlockFileEx: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
    ) => {
      koffi.encode(dacl, PVOID, options.oldAcl === null ? 0n : ptrAddress(options.oldAcl))
      koffi.encode(sacl, PVOID, options.labelAcl === null ? 0n : ptrAddress(options.labelAcl))
      koffi.encode(descriptor, PVOID, 50n)
      return 0
    }),
    setEntriesInAclW: vi.fn((count: number, entries: Buffer, _old: unknown, newAcl: NativePtr) => {
      const modes: number[] = []
      const masks: number[] = []
      const inheritances: number[] = []
      const trustees: bigint[] = []
      for (let index = 0; index < count; index++) {
        modes.push(entries.readUInt32LE(index * abi.EXPLICIT_ACCESS_W_SIZE + 4))
        masks.push(entries.readUInt32LE(index * abi.EXPLICIT_ACCESS_W_SIZE))
        inheritances.push(entries.readUInt32LE(index * abi.EXPLICIT_ACCESS_W_SIZE + 8))
        trustees.push(entries.readBigUInt64LE(index * abi.EXPLICIT_ACCESS_W_SIZE + 40))
      }
      merges.push({ count, modes, masks, inheritances, trustees })
      koffi.encode(newAcl, PVOID, 9n)
      return 0
    }),
    setNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, information: number,
      _o: unknown, _g: unknown, _dacl: unknown, sacl: NativePtr | null,
    ) => {
      applies.push({ information, sacl })
      return 0
    }),
    getLengthSid: vi.fn(() => 8),
    localAlloc: vi.fn(() => {
      labelBuilds.count++
      nextPtr += 1n
      return nextPtr as NativePtr
    }),
    initializeAcl: vi.fn(() => 1),
    addMandatoryAce: vi.fn(() => 1),
    convertStringSidToSidW: vi.fn((_sid: string, slot: NativePtr) => {
      koffi.encode(slot, PVOID, ++nextPtr)
      return 1
    }),
    createWellKnownSid: vi.fn((_type: number, _domain: null, sid: NativePtr, _size: NativePtr) => {
      koffi.encode(sid, PVOID, ++nextPtr)
      return 1
    }),
    isValidSid: vi.fn(() => 1),
    localFree: vi.fn(() => 0n as NativePtr),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...options.overrides,
  } as unknown as Win32Bindings
  return { api, applies, merges, labelBuilds }
}

describe('enrolled-workspace confinement', () => {
  // Distinct identifier authorities keep the crafted SIDs distinguishable byte-wise.
  const workspaceSid = craftSid([0, 0, 0, 0, 0, 5])
  const lowSid = craftSid([0, 0, 0, 0, 0, 16])
  const worldSid = craftSid([0, 0, 0, 0, 0, 1])

  it('a confined grant merges the ambient-delete deny and the grant, and applies DACL + label together', () => {
    const { api, applies, merges, labelBuilds } = confinementApi({ oldAcl: null, labelAcl: null })
    grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid)
    expect(merges).toHaveLength(1)
    expect(merges[0]?.count).toBe(2)
    // The deny leads the merge: DENY_ACCESS, FILE_DELETE_CHILD, container-only inheritance, the world trustee.
    expect(merges[0]?.modes[0]).toBe(abi.DENY_ACCESS)
    expect(merges[0]?.masks[0]).toBe(abi.FILE_DELETE_CHILD)
    expect(merges[0]?.inheritances[0]).toBe(abi.CONTAINER_INHERIT_ACE)
    expect(merges[0]?.trustees[0]).toBe(ptrAddress(worldSid))
    expect(merges[0]?.modes[1]).toBe(abi.GRANT_ACCESS)
    expect(merges[0]?.trustees[1]).toBe(ptrAddress(workspaceSid))
    expect(labelBuilds.count).toBe(1)
    expect(applies).toHaveLength(1)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION)
    expect(applies[0]?.sacl).not.toBeNull()
  })

  it('a legacy grant stays byte-identical DACL-only: one grant entry, no label build, no LABEL bit', () => {
    const { api, applies, merges, labelBuilds } = confinementApi({ oldAcl: null, labelAcl: null })
    grantWrite(api, 'C:/ws', workspaceSid)
    expect(merges).toHaveLength(1)
    expect(merges[0]?.count).toBe(1)
    expect(merges[0]?.modes[0]).toBe(abi.GRANT_ACCESS)
    expect(labelBuilds.count).toBe(0)
    expect(applies).toHaveLength(1)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION)
    expect(applies[0]?.sacl).toBeNull()
  })

  it('the idempotent skip requires the exact grant, deny, AND label: no merge, no apply, no label build', () => {
    const oldAcl = craftAcl([
      { sid: worldSid, type: abi.ACCESS_DENIED_ACE_TYPE, flags: abi.CONTAINER_INHERIT_ACE, mask: abi.FILE_DELETE_CHILD },
      { sid: workspaceSid, type: abi.ACCESS_ALLOWED_ACE_TYPE, flags: abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, mask: abi.GRANT_MASK },
    ])
    const labelAcl = craftLabelAcl(lowSid)
    const { api, applies, merges, labelBuilds } = confinementApi({ oldAcl, labelAcl })
    grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid)
    expect(merges).toHaveLength(0)
    expect(applies).toHaveLength(0)
    expect(labelBuilds.count).toBe(0)
  })

  it('a legacy-era standing grant without deny or label still receives the full confined apply (upgrade path)', () => {
    const oldAcl = craftAcl([grantAce(workspaceSid)])
    const { api, applies, merges } = confinementApi({ oldAcl, labelAcl: null })
    grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid)
    expect(merges).toHaveLength(1)
    expect(merges[0]?.count).toBe(2)
    expect(applies).toHaveLength(1)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION)
  })

  it('a confined revoke clears the shared label only when the last capability grant leaves', () => {
    const ownGrant = craftAcl([grantAce(workspaceSid)])
    const { api, applies, merges } = confinementApi({ oldAcl: ownGrant, labelAcl: craftLabelAcl(lowSid) })
    expect(revokeWrite(api, 'C:/ws', workspaceSid, true)).toBe(true)
    expect(merges).toHaveLength(1)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION)
    expect(applies[0]?.sacl).toBeNull()
  })

  it('a confined revoke keeps the label while a foreign capability grant remains', () => {
    // Two grants on one DACL: the surviving foreign grant keeps the shared label.
    const foreignSid = craftSid([0, 0, 0, 0, 0, 9])
    const oldAcl = craftAcl([grantAce(foreignSid)])
    const { api, applies } = confinementApi({ oldAcl, labelAcl: craftLabelAcl(lowSid) })
    expect(revokeWrite(api, 'C:/ws', workspaceSid, true)).toBe(true)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION)
  })

  it('a legacy revoke never touches labels regardless of the remaining grants', () => {
    const ownGrant = craftAcl([grantAce(workspaceSid)])
    const { api, applies } = confinementApi({ oldAcl: ownGrant, labelAcl: craftLabelAcl(lowSid) })
    expect(revokeWrite(api, 'C:/ws', workspaceSid)).toBe(true)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION)
  })

})
describe('enrolled-workspace confinement failure paths', () => {
  const workspaceSid = craftSid([0, 0, 0, 0, 0, 5])
  const lowSid = craftSid([0, 0, 0, 0, 0, 16])
  const worldSid = craftSid([0, 0, 0, 0, 0, 1])

  it('buildLowLabelAcl fails closed on a zero GetLengthSid', () => {
    const { api } = confinementApi({ oldAcl: null, labelAcl: null, overrides: { getLengthSid: vi.fn(() => 0) } })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/GetLengthSid/u)
  })

  it('buildLowLabelAcl fails closed on a null LocalAlloc', () => {
    const { api } = confinementApi({ oldAcl: null, labelAcl: null, overrides: { localAlloc: vi.fn(() => 0n as NativePtr) } })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/LocalAlloc/u)
  })

  it('buildLowLabelAcl releases the half-built ACL when InitializeAcl fails', () => {
    const frees: Array<bigint | number> = []
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: { initializeAcl: vi.fn(() => 0), localFree: vi.fn((ptr: bigint | number) => { frees.push(ptr); return 0n as NativePtr }) },
    })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/InitializeAcl/u)
    expect(frees.length).toBeGreaterThan(0)
  })

  it('buildLowLabelAcl releases the half-built ACL when AddMandatoryAce fails', () => {
    const { api } = confinementApi({ oldAcl: null, labelAcl: null, overrides: { addMandatoryAce: vi.fn(() => 0) } })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/AddMandatoryAce/u)
  })

  it('a label-build failure inside grantWrite releases the read descriptor before propagating', () => {
    const frees: Array<bigint | number> = []
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: {
        getLengthSid: vi.fn((): number => { throw new Error('GetLengthSid blew up') }),
        localFree: vi.fn((ptr: bigint | number) => { frees.push(ptr); return 0n as NativePtr }),
      },
    })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/GetLengthSid blew up/u)
    expect(frees).toContain(50n) // the descriptor allocation the read owned
  })

  it('a failed merge frees the built label ACL alongside the descriptor', () => {
    const frees: Array<bigint | number> = []
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: {
        setEntriesInAclW: vi.fn((_count: number, _entries: Buffer, _old: unknown, _newAcl: NativePtr) => 5),
        localFree: vi.fn((ptr: bigint | number) => { frees.push(ptr); return 0n as NativePtr }),
      },
    })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/SetEntriesInAclW/u)
    expect(frees).toContain(50n) // descriptor
    expect(frees.length).toBe(2) // descriptor + label ACL
  })

  it('a null merged ACL frees the built label ACL alongside the descriptor', () => {
    const frees: Array<bigint | number> = []
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: {
        setEntriesInAclW: vi.fn((_count: number, _entries: Buffer, _old: unknown, newAcl: NativePtr) => {
          koffi.encode(newAcl, PVOID, 0n)
          return 0
        }),
        localFree: vi.fn((ptr: bigint | number) => { frees.push(ptr); return 0n as NativePtr }),
      },
    })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/null new ACL/u)
    expect(frees.length).toBe(2)
  })

  it('a failed apply reports SetNamedSecurityInfoW and still frees the label ACL', () => {
    const frees: Array<bigint | number> = []
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: {
        setNamedSecurityInfoW: vi.fn(() => 5),
        localFree: vi.fn((ptr: bigint | number) => { frees.push(ptr); return 0n as NativePtr }),
      },
    })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/SetNamedSecurityInfoW/u)
    expect(frees.length).toBe(3) // descriptor + new ACL + label ACL
  })

  it('a non-null label-ACL free failure reports LocalFree after the apply', () => {
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: { localFree: vi.fn((ptr: bigint | number) => (ptr === 101n ? 999n : 0n) as NativePtr) },
    })
    expect(() => { grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid) }).toThrow(/label ACL/u)
  })

  it('the confined skip does not fire when the deny is missing (grant + exact label stand)', () => {
    const oldAcl = craftAcl([grantAce(workspaceSid)])
    const { api, merges } = confinementApi({ oldAcl, labelAcl: craftLabelAcl(lowSid) })
    grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid)
    expect(merges).toHaveLength(1)
  })

  it('the confined skip does not fire when the label names another SID', () => {
    const oldAcl = craftAcl([
      { sid: worldSid, type: abi.ACCESS_DENIED_ACE_TYPE, flags: abi.CONTAINER_INHERIT_ACE, mask: abi.FILE_DELETE_CHILD },
      { sid: workspaceSid, type: abi.ACCESS_ALLOWED_ACE_TYPE, flags: abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, mask: abi.GRANT_MASK },
    ])
    const otherLow = craftSid([0, 0, 0, 0, 0, 17])
    const { api, merges } = confinementApi({ oldAcl, labelAcl: craftLabelAcl(otherLow) })
    grantWrite(api, 'C:/ws', workspaceSid, lowSid, worldSid)
    expect(merges).toHaveLength(1)
  })

  it('the legacy skip still fires on the exact grant alone', () => {
    const oldAcl = craftAcl([grantAce(workspaceSid)])
    const { api, applies, merges } = confinementApi({ oldAcl, labelAcl: null })
    grantWrite(api, 'C:/ws', workspaceSid)
    expect(merges).toHaveLength(0)
    expect(applies).toHaveLength(0)
  })

  it('malformed ACL headers read as no-match: the implausible sizes fall back to the merge path', () => {
    // AclSize below the 8-byte header.
    const tiny = allocBytes(32)
    koffi.encode(tiny, 'uint8', 2)
    koffi.encode(tiny, 2, 'uint16', 4)
    koffi.encode(tiny, 4, 'uint16', 1)
    const { api: tinyApi, merges: tinyMerges } = confinementApi({ oldAcl: tiny, labelAcl: null })
    grantWrite(tinyApi, 'C:/ws', workspaceSid)
    expect(tinyMerges).toHaveLength(1)

    // An ACE claiming a size smaller than its own header.
    const stubAce = allocBytes(32)
    koffi.encode(stubAce, 'uint8', 2)
    koffi.encode(stubAce, 2, 'uint16', 24)
    koffi.encode(stubAce, 4, 'uint16', 1)
    koffi.encode(stubAce, 8 + 2, 'uint16', 4)
    const { api: stubApi, merges: stubMerges } = confinementApi({ oldAcl: stubAce, labelAcl: null })
    grantWrite(stubApi, 'C:/ws', workspaceSid)
    expect(stubMerges).toHaveLength(1)

    // An ACE running past the declared ACL size.
    const overrun = allocBytes(32)
    koffi.encode(overrun, 'uint8', 2)
    koffi.encode(overrun, 2, 'uint16', 24)
    koffi.encode(overrun, 4, 'uint16', 1)
    koffi.encode(overrun, 8 + 2, 'uint16', 64)
    const { api: overrunApi, merges: overrunMerges } = confinementApi({ oldAcl: overrun, labelAcl: null })
    grantWrite(overrunApi, 'C:/ws', workspaceSid)
    expect(overrunMerges).toHaveLength(1)
  })

  it('a confined AclWriteGrant materializes and disposes through the confinement pair', () => {
    const { api, applies } = confinementApi({ oldAcl: null, labelAcl: null })
    const grant = AclWriteGrant.create('S-1-4-9000-9', { confined: true, api })
    grant.add('C:/ws-temp', false)
    expect(applies).toHaveLength(1)
    expect(applies[0]?.information).toBe(abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION)
    grant.dispose()
  })

  it('a confined AclWriteGrant create fails closed when the world SID fails: the Low SID is released first', () => {
    const frees: Array<bigint | number> = []
    const createWellKnownSid = vi.fn((_type: number) => 1)
    const { api } = confinementApi({
      oldAcl: null, labelAcl: null,
      overrides: {
        createWellKnownSid,
        localFree: vi.fn((ptr: bigint | number) => { frees.push(ptr); return 0n as NativePtr }),
      },
    })
    createWellKnownSid.mockImplementationOnce(() => 1) // the Low label SID succeeds
    createWellKnownSid.mockImplementationOnce(() => 0) // the world SID fails
    expect(() => AclWriteGrant.create('S-1-4-9000-10', { confined: true, api })).toThrow(/CreateWellKnownSid/u)
    expect(frees.length).toBe(2) // Low label SID, then the parsed write SID
  })
})
