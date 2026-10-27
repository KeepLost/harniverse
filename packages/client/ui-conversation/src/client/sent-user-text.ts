/**
 * Sent-user-text decoration seam: plugins register rules whose matched ranges
 * render through the rule's own component. A rule changes only what is drawn —
 * the logged message text, copy actions, and model input keep the original
 * characters. The registry is this package's module state because sent-text
 * decoration is a display concern of its chat rendering; other packages
 * register through the `conversation` service's `sentUserText` face (a value
 * import here would fail the client bundle purity gate by design).
 */
import { useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'

/** Props the seam passes to a rule's run renderer. */
export interface SentUserTextRunProps {
  /** The matched range's original characters; display-only. */
  readonly raw: string
  /** Whether the containing text admits interaction (a sent or admitted steering message). */
  readonly interactive: boolean
  /** The rule's own payload from `nextMatch`, when it prepared one. */
  readonly data?: unknown
}

/** One plugin's sent-user-text decoration. */
export interface SentUserTextRule {
  /** Stable rule id, used for diagnostics. */
  readonly id: string
  /**
   * The next matched range at or after `from` in `text`. Rules are queried
   * repeatedly with advancing offsets, so a rule may memoize per text.
   */
  nextMatch(text: string, from: number): { readonly start: number; readonly end: number; readonly data?: unknown } | undefined
  /** Render one matched range. */
  readonly Render: ComponentType<SentUserTextRunProps>
}

const listeners = new Set<() => void>()
let snapshot: readonly SentUserTextRule[] = []

function publish(next: readonly SentUserTextRule[]): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** The sent-user-text rule registry; reactive through `subscribe`/`getSnapshot`. */
export const sentUserTextRules = {
  /**
   * Register one rule.
   * @param rule - the decoration to add.
   * @returns the disposer that removes exactly this registration.
   */
  register(rule: SentUserTextRule): () => void {
    publish([...snapshot, rule])
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      publish(snapshot.filter(entry => entry !== rule))
    }
  },
  /** The currently registered rules. */
  list(): readonly SentUserTextRule[] {
    return snapshot
  },
  /** Registry subscription for `useSyncExternalStore`. */
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** Registry snapshot for `useSyncExternalStore`. */
  getSnapshot: (): readonly SentUserTextRule[] => snapshot,
}

/**
 * The currently registered rules as a reactive hook consumer.
 * @returns the rules snapshot, re-rendered on registration changes.
 */
export function useSentUserTextRules(): readonly SentUserTextRule[] {
  return useSyncExternalStore(sentUserTextRules.subscribe, sentUserTextRules.getSnapshot)
}
