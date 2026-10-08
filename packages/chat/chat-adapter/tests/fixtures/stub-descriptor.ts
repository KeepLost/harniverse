/** Minimal transport-free {@link ChatPlatformDescriptor} for registry tests. */

import type { ChatPlatformDescriptor } from '../../src/types.ts'

/**
 * Build a descriptor whose probe and mount are never exercised.
 * @param platform - platform id.
 * @returns the stub descriptor.
 */
export function stubDescriptor(platform: string): ChatPlatformDescriptor {
  return {
    platform,
    label: platform,
    fields: [{ key: 'token', label: '令牌', secret: true, required: true }],
    probe: () => Promise.resolve({ botId: 'stub', displayName: 'Stub' }),
    mount: () => Promise.resolve(),
  }
}
