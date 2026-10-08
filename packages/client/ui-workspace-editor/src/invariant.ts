/** Package-owned invariant companion for ui-workspace-editor. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workspace-editor'
export const name = 'ui-workspace-editor-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin is a pure presentation occupant whose
 * writes all pass the Host-side version CAS; it owns no cross-event relation
 * the invariant registry could observe from the client context.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
