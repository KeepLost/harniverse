/**
 * Types for the age-based image-offload contract: the global
 * `imageOffloadAfterUserTurns` setting, per-image targets located inside the
 * durable log, and the `image/offload` session event that records one settled
 * projection decision. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-image-offload-policy
 */

/**
 * The global image-retention stance. `'unlimited'` (the default) imposes no
 * user-turn age limit, so provider pressure and ordinary compaction remain
 * the only unload paths. A positive integer unloads each image once that many
 * later user-message turns have been appended after the event carrying it,
 * at the earlier of that age or provider pressure.
 */
export type ImageOffloadSetting = 'unlimited' | number

/** Locates one image occurrence: the surface event's `seq` plus the 0-based index of the image among that event's image blocks. */
export interface ImageOffloadTarget {
  /** `seq` of the user/message or tool/result event whose content carries the image. */
  readonly messageSeq: number
  /** 0-based position of this image among that event's image blocks, in block order. */
  readonly imageIndex: number
}

/**
 * Why one image unloaded. `'age'` is the configured user-turn limit;
 * `'pressure'` is the provider's offload demand choosing the oldest images.
 */
export type ImageOffloadReason = 'age' | 'pressure'

/** One pending unload decision, before it is appended as `image/offload`. */
export interface ImageOffloadDecision {
  readonly target: ImageOffloadTarget
  readonly reason: ImageOffloadReason
}

/**
 * Payload of the durable `image/offload` event: the image occurrences whose
 * model-request projection becomes the truthful text stub from this point on.
 * The original attachments stay retained; replay and authorized re-reads keep
 * working. Required-on-read: skipping it would reconstruct image-bearing
 * history the running requests no longer contain.
 */
export interface ImageOffloadEventData {
  /** Occurrences settled by this one decision, each located by event seq and image index. */
  readonly targets: readonly ImageOffloadTarget[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that the listed image occurrences are offloaded from the model
     * request projection: later requests render the canonical offload stub
     * text in place of each image, while the original attachments remain
     * retained for replay and authorized re-reads. Each target names the
     * surface event (`user/message` or `tool/result`) carrying the image and
     * the 0-based index among that event's image blocks. Appended at a
     * request-assembly decision point after either the configured
     * `imageOffloadAfterUserTurns` age limit or provider pressure chose the
     * images; an occurrence settled here or shadowed by a compaction
     * replacement is never chosen again.
     */
    'image/offload': ImageOffloadEventData
  }
}
