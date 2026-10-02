/**
 * Speech domain contract: one transcription verb over the recognizer seam
 * (`ctx.speech`) and one preparation verb for local recognizer assets. The
 * recognizer selection itself lives in the `speech` settings namespace; the
 * gateway resolves it per request.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Settled readiness observation of one recognizer's local resources. */
export interface SpeechPrepareView {
  /** Whether the recognizer can serve a transcription right now. */
  status: 'ready' | 'unprepared' | 'failed'
  /** Provider-supplied diagnostic for a `failed` observation. */
  detail?: string
}

/**
 * Host-facing voice-input surface. Both methods authorize through
 * `harniverse.operate`: transcription spends cloud budget or local CPU, and
 * preparation downloads hundreds of megabytes into `$DSH_HOME`.
 */
export interface SpeechApi {
  /**
   * Validate one canonical 16 kHz mono PCM16 WAV recording and transcribe it
   * through the settings-selected recognizer.
   */
  transcribe(request: RpcRequest<{
    /** Canonical WAV bytes, base64-encoded. */
    wavBase64: string
    /** Language hint overriding the settings default for this request. */
    language?: string
  }>, signal: AbortSignal): Promise<RpcResponse<{ text: string }>>

  /**
   * Start or join the resolved recognizer's asset preparation (download and
   * sha256 verification) and answer with its settled state.
   */
  prepare(request: RpcRequest<{}>): Promise<RpcResponse<SpeechPrepareView>>
}
