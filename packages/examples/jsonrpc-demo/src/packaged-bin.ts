#!/usr/bin/env node
/**
 * Closed-runtime JSON-RPC agent bin. Bare plugins resolve from the installed
 * runtime closure while relative plugins remain configuration-relative.
 *
 * A respawn carrying `DSH_PTC_RUNTIME_NODE` boots the PTC runtime child
 * instead of the agent: inside a single-file executable there is no child
 * entry file to point Node at, so the PTC runtime respawns the executable
 * itself (heap cap through `NODE_OPTIONS`) and this bin routes to the child
 * entry the executable carries — one binary serves both roles. The routing
 * variable is removed before the child runs so model code still observes
 * the runtime's empty-environment contract.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin
 */

import { runJsonrpcAgent } from './runner.ts'

if (process.env.DSH_PTC_RUNTIME_NODE === '1') {
  Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
  await import('@deepseek-ai/dsh-ptc-runtime-node/child')
} else {
  /* v8 ignore next -- exercised through the built Python runtime carriers */
  await runJsonrpcAgent(import.meta.url)
}
