/**
 * Live `serverName` reservations shared by every mcp-client exposure route.
 *
 * @module
 */

/**
 * Live `serverName` reservations per app and optional owner key. Scoped
 * profile compositions may mount the same user server in separate
 * registries, while direct rows without an owner key retain one-app
 * duplicate detection.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

/**
 * Resolve (creating when absent) the reservation set of one app root.
 * @param reservationScope - the app root object a reservation is keyed by.
 * @returns the mutable set of live reservation names.
 */
export function activeServerNamesOf(reservationScope: object): Set<string> {
  let names = activeServerNames.get(reservationScope)
  if (!names) {
    names = new Set()
    activeServerNames.set(reservationScope, names)
  }
  return names
}
