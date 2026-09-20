/**
 * The immutable execution-world descriptor contract: parse and verify a
 * machine's self-description, compute its canonical digest, and refuse
 * host-local authority. Pure contract — publishing, transport, and the
 * execution providers that consume descriptors compose this package.
 *
 * @module @deepseek-ai/dsh-execution-descriptor
 */

export {
  buildExecutionWorldDescriptor,
  canonicalExecutionWorldJson,
  computeExecutionWorldDigest,
  ExecutionDescriptorError,
  LOCAL_ONLY_PRESET_IDS,
  parseExecutionWorldDescriptor,
} from './descriptor.ts'
export type { ExecutionWorldDescriptorInput } from './descriptor.ts'
export type { ExecutionTransport, ExecutionWorldDescriptor } from './types.ts'
