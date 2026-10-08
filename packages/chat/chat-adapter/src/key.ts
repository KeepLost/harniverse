/**
 * Registry key derivation shared by the registry and its invariant companion.
 * @module @deepseek-ai/dsh-chat-adapter/key
 */

import type { ChatPlatformId } from './types.ts'

/**
 * Registry key of one bot instance of one platform.
 * @param platform - adapter platform id.
 * @param botId - adapter bot instance id.
 * @returns the `platform:botId` key.
 */
export function chatAdapterKey(platform: ChatPlatformId, botId: string): string {
  return `${platform}:${botId}`
}
