/**
 * Hover-capability probe for pointer-triggered surfaces.
 *
 * Touch primaries have no hover to lose: a tap dispatches a synthetic
 * enter (mouse or pointer), but no leave follows until a later tap lands
 * on another interactive element — a hover-opened surface would therefore
 * stick on screen with no reliable dismissal path (iOS Safari behavior;
 * tapping blank non-interactive areas does not clear hover state). Pointer
 * surfaces suppress their hover trigger there; keyboard focus keeps its own.
 */

/**
 * Whether the primary pointer can genuinely hover.
 * @returns false on touch primaries; true when hover support is unknown
 * (no matchMedia, e.g. jsdom without a stub) — the desktop-safe default.
 */
export function hoverCapablePointer(): boolean {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(hover: hover)') : undefined
  return query?.matches ?? true
}
