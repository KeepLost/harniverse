/** Minimal transport-free {@link ChatAdapter} for registry tests. */

import type { ChatAdapter, ChatAdapterCapabilities } from '../../src/types.ts'

const CAPABILITIES: ChatAdapterCapabilities = {
  groupChats: false, threads: false, editOutbound: false, editWindowMs: null,
  minEditIntervalMs: 0, maxTextLength: 1, textFormat: 'plain', interactionButtons: false,
  reactions: false, typingIndicator: false, inboundFiles: false, outboundFiles: false,
  maxFileBytes: 0,
}

/**
 * Build a stub adapter whose transport methods are never exercised.
 * @param platform - platform id.
 * @param botId - bot instance id.
 * @returns the stub.
 */
export function stubAdapter(platform: string, botId: string): ChatAdapter {
  return {
    platform,
    botId,
    capabilities: CAPABILITIES,
    run: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: () => Promise.reject(new Error('stub adapter has no transport')),
    fetchAttachment: () => Promise.reject(new Error('stub adapter has no transport')),
    directRoute: () => undefined,
  }
}
