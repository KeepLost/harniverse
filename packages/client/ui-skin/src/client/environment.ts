/**
 * Operating-system rendering preferences. Reduced transparency and high
 * contrast are accessibility requests that outrank the user's own translucency
 * and glass choices, so the runtime watches them and answers live.
 * @module @deepseek-ai/dsh-client-ui-skin/environment
 */
import type { EnvironmentView } from './view.ts'

/** A `matchMedia`-shaped query evaluator. */
export type MatchMedia = (query: string) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>

/** Live read access to the rendering preferences. */
export interface EnvironmentSource {
  /** @returns the current preferences. */
  snapshot(): EnvironmentView
  /**
   * Observe preference changes.
   * @param listener - called after either preference flips.
   * @returns disposer removing the listener.
   */
  subscribe(listener: () => void): () => void
}

const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'
const HIGH_CONTRAST = '(prefers-contrast: more)'

/**
 * Build a source over a media-query evaluator.
 * @param matchMedia - the evaluator, or undefined where the host has none (node runs, old browsers): preferences then read as unset.
 * @returns the environment source.
 */
export function createEnvironmentSource(matchMedia: MatchMedia | undefined): EnvironmentSource {
  if (matchMedia === undefined) {
    return {
      snapshot: () => ({ reducedTransparency: false, highContrast: false }),
      subscribe: () => () => {},
    }
  }
  const reduced = matchMedia(REDUCED_TRANSPARENCY)
  const contrast = matchMedia(HIGH_CONTRAST)
  return {
    snapshot: () => ({ reducedTransparency: reduced.matches, highContrast: contrast.matches }),
    subscribe: (listener) => {
      reduced.addEventListener('change', listener)
      contrast.addEventListener('change', listener)
      return () => {
        reduced.removeEventListener('change', listener)
        contrast.removeEventListener('change', listener)
      }
    },
  }
}

/**
 * The browser's own environment.
 * @returns a source over `window.matchMedia`, or the unset source outside a browser.
 */
export function browserEnvironment(): EnvironmentSource {
  return createEnvironmentSource(typeof globalThis.matchMedia === 'function' ? query => globalThis.matchMedia(query) : undefined)
}
