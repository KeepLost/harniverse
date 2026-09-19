/**
 * The age-based image-offload contract: setting parsing, per-image aging and
 * pressure decision rules, the durable `image/offload` event vocabulary, and
 * the canonical offload stub text. Pure contract — the compaction/request
 * projection that applies these decisions composes this package later.
 *
 * @module @deepseek-ai/dsh-image-offload-policy
 */

export {
  OFFLOADED_IMAGE_STUB_TEXT,
  parseImageOffloadSetting,
  resolveImageOffloadDecisions,
} from './policy.ts'
export type { ImageOffloadOptions } from './policy.ts'
export type {
  ImageOffloadDecision,
  ImageOffloadEventData,
  ImageOffloadReason,
  ImageOffloadSetting,
  ImageOffloadTarget,
} from './types.ts'
