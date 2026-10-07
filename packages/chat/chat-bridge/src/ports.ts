/**
 * The slice of the Harniverse client service the bridge depends on. A test
 * double implements exactly this.
 * @module @deepseek-ai/dsh-chat-bridge/ports
 */

import type HarniverseClient from '@deepseek-ai/dsh-chat-harniverse-client'

/** Client operations the bridge calls. */
export type BridgeClient = Pick<HarniverseClient, 'call' | 'typert' | 'respond' | 'upload' | 'openMux' | 'describeHost'>
