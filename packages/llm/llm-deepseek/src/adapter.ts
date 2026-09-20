/** Select a DeepSeek wire implementation from one validated configuration generation. */

import { assertNever, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DeepSeekAdapterOptions } from './common/types.ts'
import { ChatCompletionsAdapter } from './protocols/chat-completions/adapter.ts'
import { DeepSeekFileStore } from './common/file-store.ts'
import { DeepSeekMessagesAdapter } from './protocols/messages/adapter.ts'

export type {
  DeepSeekAdapterOptions,
  DeepSeekCatalogModel,
  DeepSeekConnectionOptions,
  DeepSeekProtocol,
  RequestDefaults,
} from './common/types.ts'
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_FILE_EXPIRY_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './common/defaults.ts'

/** One provider route with protocol-local transport and shared credentials and model configuration. */
export class DeepSeekAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly dependencies: DeepSeekAdapterOptions) {
    super()
    this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  private implementation(): LlmAdapter {
    const connection = this.dependencies.options()
    // Protocol adapters re-read the connection for every operation; hand them
    // the snapshot this dispatch already resolved instead of the live source,
    // so one call resolves connection facts exactly once.
    const resolved: DeepSeekAdapterOptions = { ...this.dependencies, options: () => connection }
    switch (connection.protocol) {
      case 'messages':
        return new DeepSeekMessagesAdapter(resolved, this.files)
      case 'chat-completions':
        return new ChatCompletionsAdapter(resolved, this.files)
      /* v8 ignore next -- protocol is validated at configuration resolution. */
      default: return assertNever(connection.protocol, 'DeepSeek protocol')
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.implementation().providerInfo(provider)
  }

  override providerRetryPolicy(provider: string) {
    return this.implementation().providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.implementation().listModels(provider)
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.implementation().resolveModel(provider, model, signal)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.implementation().stream(options)
  }
}
