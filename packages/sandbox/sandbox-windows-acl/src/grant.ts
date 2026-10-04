/**
 * Server-side write-grant materialization. The sandbox seam holds one
 * standing workspace grant per workspace and one revocable temp grant per
 * live session/workspace pair. Workspace identities survive by deterministic
 * derivation and their standing ACE; temp identities derive from random
 * private paths and are deliberately new after a restart.
 *
 * Fail-closed: `add` throws on any grant failure and the caller disposes the
 * instance (revoking every path granted so far); `dispose` revokes every
 * standing grant and reports every cleanup failure.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/grant
 */

import { grantWrite, revokeWrite } from './acl.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32Sync } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { makeWellKnownSid } from './token.ts'
import * as abi from './win32-abi.ts'

/**
 * One write SID's provider-lifetime grant materialization: the parsed SID
 * pointer plus every directory whose DACL currently carries its ACE — and,
 * under the enrolled-workspace confinement, whose SACL carries the Low
 * mandatory label and whose DACL carries the ambient-delete deny (see
 * {@link grantWrite}). Workspace paths are added STANDING (their ACEs are the
 * cross-session reuse cache and outlive the grant — dispose() skips revoking
 * them, or the next provision would re-propagate the whole tree); temp paths
 * are revocable (dispose() revokes them — an inheritable ACE must not outlive
 * its session's temp directory). Create with {@link AclWriteGrant.create};
 * dispose revokes the revocable paths and frees every SID.
 */
export class AclWriteGrant {
  /** The write SID in SDDL string form. */
  readonly writeSid: string
  private readonly api: Win32Bindings
  private readonly sidPtr: NativePtr
  private readonly lowLabelSidPtr: NativePtr | undefined
  private readonly worldSidPtr: NativePtr | undefined
  private readonly revocablePaths: string[] = []
  private readonly standingPaths: string[] = []

  private constructor(
    api: Win32Bindings, sidPtr: NativePtr, writeSid: string,
    lowLabelSidPtr: NativePtr | undefined, worldSidPtr: NativePtr | undefined,
  ) {
    this.api = api
    this.sidPtr = sidPtr
    this.lowLabelSidPtr = lowLabelSidPtr
    this.worldSidPtr = worldSidPtr
    this.writeSid = writeSid
  }

  /**
   * Parse the SID string, create the Low integrity and world SIDs the
   * confined grants label and deny with, and open the binding table (lazily,
   * once per server). Fail-closed: any failure throws — nothing is granted
   * yet, and every allocation made along the way is released.
   * @param writeSid - the workspace (`S-1-4-x-y`) or temp (`S-1-4-x-y-1`) capability SID string.
   * @param options - `confined` materializes the enrolled-workspace confinement
   *   (Low label + ambient-delete deny); `api` supplies already-resolved
   *   bindings (tests).
   * @returns the ready grant (no ACEs yet).
   */
  static create(writeSid: string, options: { confined?: boolean; api?: Win32Bindings } = {}): AclWriteGrant {
    const bindings = options.api ?? win32Sync()
    const sidSlot = allocPtrSlot()
    if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0) {
      throwLastError(bindings, 'ConvertStringSidToSidW', writeSid)
    }
    const sidPtr = decodePtr(sidSlot)
    if (sidPtr === null) throwLastError(bindings, 'ConvertStringSidToSidW', `null SID for ${writeSid}`)
    if (options.confined !== true) return new AclWriteGrant(bindings, sidPtr, writeSid, undefined, undefined)
    const lowLabelSidPtr = makeWellKnownSid(bindings, abi.WinLowLabelSid)
    try {
      const worldSidPtr = makeWellKnownSid(bindings, abi.WinWorldSid)
      return new AclWriteGrant(bindings, sidPtr, writeSid, lowLabelSidPtr, worldSidPtr)
    } catch (error) {
      // The Low label SID is LocalAlloc'd: release it before the world-SID
      // failure propagates to the sidPtr release below.
      bindings.localFree(lowLabelSidPtr)
      throw error
    }
  }

  /**
   * Grant the write ACE — plus, when created `confined`, the ambient-delete
   * deny and the Low mandatory label — on one directory (idempotent: an
   * already-standing exact entry set skips the eager full-tree
   * re-propagation — see {@link grantWrite}) and record the path for
   * {@link dispose} unless it is standing. The path is recorded BEFORE the
   * grant: a post-apply throw (a LocalFree failure after
   * SetNamedSecurityInfoW succeeded) must still revoke it, and revoking an
   * ungranted path is a no-op merge. Callers treat a throw as a failed
   * materialization and dispose the instance to revoke the paths granted so
   * far.
   * @param path - the directory whose DACL gains the grant.
   * @param standing - the ACE outlives this grant (the workspace reuse
   *   cache; dispose() skips revoking it). Default false (revoked on
   *   dispose — the temp-directory lifecycle).
   */
  add(path: string, standing = false): void {
    ;(standing ? this.standingPaths : this.revocablePaths).push(path)
    grantWrite(this.api, path, this.sidPtr, this.lowLabelSidPtr, this.worldSidPtr)
  }

  /** Every directory currently carrying the grant, in grant order. */
  get paths(): readonly string[] {
    return [...this.standingPaths, ...this.revocablePaths]
  }

  /** Revoke every revocable grant (standing ACEs stay) and free every SID; reports every cleanup failure. */
  dispose(): void {
    const failures: unknown[] = []
    const confined = this.lowLabelSidPtr !== undefined
    for (const path of this.revocablePaths) {
      try {
        revokeWrite(this.api, path, this.sidPtr, confined)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const [label, sidPtr] of [
      ['write SID', this.sidPtr],
      ...this.lowLabelSidPtr === undefined ? [] : [['Low label SID', this.lowLabelSidPtr] as const],
      ...this.worldSidPtr === undefined ? [] : [['world SID', this.worldSidPtr] as const],
    ] as const) {
      try {
        const freed = this.api.localFree(sidPtr)
        if (!isNullPtr(freed)) throwLastError(this.api, 'LocalFree', label)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}
