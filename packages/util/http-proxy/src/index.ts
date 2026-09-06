/**
 * Outbound HTTP proxy support for DeepSeek Harness, carried natively in Harniverse.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. The launcher resolves one policy from the launch
 * environment and installs it behind the dispatcher symbol Node's global `fetch` resolves — so LLM
 * adapters, web search, and any plain `fetch()` caller are covered without touching their code.
 *
 * This is a library, not a plugin: transport policy has one answer per process, so there is nothing
 * for a composition to mount, swap, or scope.
 *
 * One resolver, one tunnel: `requestViaProxy` is the single way a proxied request is spoken, so the
 * installed dispatcher, `dsh-web-fetch-http`, and any later native consumer cannot disagree.
 * @module @deepseek-ai/dsh-http-proxy
 */

export {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type ProxyRoute,
} from './install.ts'
export {
  requestViaProxy,
  type DispatchHandlers,
  type DispatchOptions,
  type Dispatcher,
  type ProxyHop,
  type ProxyRequestOptions,
} from './dispatcher.ts'
