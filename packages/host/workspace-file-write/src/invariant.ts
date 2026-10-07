/** Package-owned invariant companion for workspace-file-write. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workspace-file-write'
export const name = 'workspace-file-write-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: the commit-point event's payload mirrors the write
 * the same service just performed inside one method call, so no second
 * observable owner exists to cross-check the relation against.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
