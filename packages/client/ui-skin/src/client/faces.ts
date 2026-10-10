/**
 * Shared shapes of the inject faces: every skin surface reads the one
 * published view through the same `hooks` seat.
 * @module @deepseek-ai/dsh-client-ui-skin/faces
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkinView } from './view.ts'

/**
 * The reserved hooks compartment: the renderer binds `skin` to a
 * `useSkin(selector)` hook. A type alias, not an interface: the slot types
 * accept a compartment only when it has an implicit index signature.
 */
export type SkinHooks = { skin: HostObservable<SkinView> }
