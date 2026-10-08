/**
 * Pure text-encoding library shared by the filesystem backend, the workbench
 * preview, and subprocess output collection. No Cordis service, no plugin
 * registration, no mutable state: every entry point is a function over whole
 * buffers.
 * @module @deepseek-ai/dsh-fs-codec
 */

export {
  bomBytesFor,
  decodeStrict,
  encodingExists,
  isUtf8Continuation,
  sniffAndDecode,
  sniffBom,
  utf8BoundaryEnd,
} from './decode.ts'
export { displayEncoding, encodingAnnotation, SOURCE_LABELS, suggestEncodings } from './display.ts'
export { encodeForWrite } from './encode.ts'
export { hostPriors, hostPriorsSync, hostFilePrior, localeLanguagePrior, outputLegacyForCodePage } from './priors.ts'
export { decodeOutputWindow } from './output.ts'
export type { OutputDecodeResult } from './output.ts'
export type {
  EncodeForWriteOptions,
  EncodeOutcome,
  EncodingDecision,
  EncodingSource,
  HostPriors,
  HostPriorsDeps,
  OutputDecodingSpec,
  SniffOptions,
  SniffOutcome,
  UnmappableChar,
} from './types.ts'
