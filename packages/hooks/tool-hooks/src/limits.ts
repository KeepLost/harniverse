/** Deployment-owned numeric bounds and scope vocabulary for the hook tools. */

import type { HookScope } from './index.ts'

/** Hard ceiling for one hook's kill timeout, in seconds (the dialect default). */
export const MAX_TIMEOUT_SECONDS = 600

/** Default cap on total hook groups kept in one scope's store. */
export const DEFAULT_MAX_HOOKS = 256

/** Every scope the tools accept, in disclosure order. */
export const SCOPE_VALUES: readonly HookScope[] = ['session', 'workspace', 'global']
