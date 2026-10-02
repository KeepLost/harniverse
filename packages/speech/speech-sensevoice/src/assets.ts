/**
 * Release-pinned downloadable SenseVoice assets and the verification
 * manifest. Model, tokens, and VAD files come from the upstream
 * `sherpa-onnx-sense-voice` release pinned by URL revision; sha256 values
 * are the pinned release's digests, so a drifted upstream file fails
 * verification instead of loading.
 */

/** One pinned downloadable file. */
export interface PinnedAsset {
  /** File name inside the provider asset directory. */
  readonly name: string
  /** Revision-pinned Hugging Face file URL; the path is re-hosted per origin. */
  readonly url: string
  /** Exact pinned size in bytes; a mismatch fails verification. */
  readonly bytes: number
  /** Pinned sha256 hex digest; a mismatch fails verification. */
  readonly sha256: string
}

/** Hugging Face-compatible origins probed in order before each missing download. */
export const SENSEVOICE_ASSET_ORIGINS: readonly string[] = ['https://huggingface.co', 'https://hf-mirror.com']

/** Weight precision variants; INT8 minimizes first-use download and storage. */
export type SenseVoiceVariant = 'int8' | 'fp32'

/** Pinned model weights per precision variant. */
export const SENSEVOICE_MODELS: Readonly<Record<SenseVoiceVariant, PinnedAsset>> = {
  int8: {
    name: 'model.int8.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    bytes: 239_233_841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  },
  fp32: {
    name: 'model.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.onnx',
    bytes: 937_617_178,
    sha256: '977016bd9c79f9eb343430b5cc305e07ab64d5212dff41b0dcfa1694bee9a8cb',
  },
}

/** Pinned SenseVoice token table shared by both variants. */
export const SENSEVOICE_TOKENS: PinnedAsset = {
  name: 'tokens.txt',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
  bytes: 315_894,
  sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
}

/** Pinned Silero voice-activity detector used to segment long recordings. */
export const SILO_VAD: PinnedAsset = {
  name: 'silero_vad.onnx',
  url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  bytes: 1_807_522,
  sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
}

/** Version of the on-disk manifest schema written after verification. */
export const ASSET_MANIFEST_VERSION = 1

/** The on-disk verification manifest: the pinned digests this installation accepted. */
export interface AssetManifest {
  /** Manifest schema version. */
  readonly version: number
  /** Pinned assets by role; each value matches the pinned release exactly. */
  readonly assets: {
    readonly model: PinnedAsset
    readonly tokens: PinnedAsset
    readonly vad: PinnedAsset
  }
}

/** The pinned manifest for one precision variant. */
export function pinnedManifest(variant: SenseVoiceVariant): AssetManifest {
  return {
    version: ASSET_MANIFEST_VERSION,
    assets: { model: SENSEVOICE_MODELS[variant], tokens: SENSEVOICE_TOKENS, vad: SILO_VAD },
  }
}
