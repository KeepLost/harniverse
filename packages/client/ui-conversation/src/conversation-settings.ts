/** Durable conversation preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Field carrying which machine opens a link in assistant prose. */
export const LINK_DESTINATION_FIELD = 'linkDestination'

/** Machines that can open a link a reader clicks. */
export const LINK_DESTINATIONS = ['panel', 'device'] as const

/**
 * Which machine opens a link in assistant prose. `'panel'` loads it in the
 * harness host's own browser, which is what reaches a host-local dev server or
 * an intranet address; `'device'` hands it to the browser the reader is sitting
 * in, which is the only option when the host has no browser at all.
 */
export type LinkDestination = typeof LINK_DESTINATIONS[number]

/** Default keeps the host's network position, the reason the panel exists. */
export const DEFAULT_LINK_DESTINATION: LinkDestination = 'panel'

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
  /** Machine that opens a link in assistant prose. */
  linkDestination: LinkDestination
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  [LINK_DESTINATION_FIELD]: z.union([...LINK_DESTINATIONS]).default(DEFAULT_LINK_DESTINATION),
})
