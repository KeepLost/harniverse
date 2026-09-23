/**
 * Queue read face for the InputState.queue projection (frozen contract in
 * ../contract/input.ts): a uSES-compatible observable over one session's
 * transient inbox rows. The Session snapshot already keeps the queue array
 * reference-stable across unrelated snapshot swaps, so this is a pure
 * projection — no second store, no copy.
 */
