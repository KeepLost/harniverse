/**
 * Proxy installation: the transport half of this package. It owns the global-dispatcher symbol
 * Node's built-in `fetch` resolves through and the process-wide record of which policy is active.
 *
 * Harniverse carries this natively — Node bundles no importable `undici` — so the installed
 * dispatcher is {@link ProxyDispatcher} and the swap happens through the dispatcher symbol itself.
 * @module @deepseek-ai/dsh-http-proxy/install
 */

import {
  GLOBAL_DISPATCHER_SYMBOL,
  ProxyDispatcher,
  type Dispatcher,
} from './dispatcher.ts'
import {
  proxyForUrl,
  resolveProxyPolicy,
  PROXY_ENV_NAMES,
  type EnvLookup,
  type ProxyPolicy,
} from './policy.ts'

/** The active policy, or `undefined` until one is installed. Process-wide, like the dispatcher it tracks. */
let active: ProxyPolicy | undefined

/** The dispatcher installed with {@link active}, so a route can hand back the one already routing. */
let installed: ProxyDispatcher | undefined

/**
 * How this process must send one request.
 *
 * A caller that branches on the answer builds its transport from the returned proxy URL, so the
 * route and the hop cannot disagree after an install or disposal lands between two separate reads.
 * The proxied arm carries no transport of its own: the one shared tunnel builder serves every
 * native consumer, so no caller can send a proxied request some other way.
 */
export type ProxyRoute =
  | { readonly proxied: true; readonly proxy: string }
  | { readonly proxied: false }

/** A route that sends nothing through a proxy, shared because it carries no per-request state. */
const DIRECT_ROUTE: ProxyRoute = { proxied: false }

/**
 * Decide how to send one request, answering from a single read of the active policy.
 *
 * @param url - the request URL.
 * @returns the proxied route with its proxy URL, or the direct route.
 */
export function proxyRouteFor(url: URL): ProxyRoute {
  const policy = active
  if (policy === undefined) return DIRECT_ROUTE
  const proxy = proxyForUrl(policy, url)
  return proxy === undefined ? DIRECT_ROUTE : { proxied: true, proxy }
}

/** The dispatcher global `fetch` is using now; `undefined` is Node's own internal default. */
function currentGlobalDispatcher(): Dispatcher | undefined {
  const value = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER_SYMBOL]
  /* v8 ignore next -- Node normally exposes a dispatcher after fetch boot. */
  return value === undefined ? undefined : value as Dispatcher
}

/** Install `dispatcher` as the global one `fetch` resolves; `undefined` restores Node's default. */
function setGlobalDispatcher(dispatcher: Dispatcher | undefined): void {
  if (dispatcher === undefined) Reflect.deleteProperty(globalThis, GLOBAL_DISPATCHER_SYMBOL)
  else (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER_SYMBOL] = dispatcher
}

/**
 * Route this process's outbound HTTP through `policy`.
 *
 * Installing replaces the dispatcher behind Node's global `fetch`, so every caller that issues a
 * plain `fetch()` is covered without knowing this package exists. A policy that proxies nothing
 * installs nothing: with no proxy exported, `fetch` keeps Node's internal default transport
 * byte-for-byte. The process environment is never rewritten — children get the user's own
 * variables or none (see {@link clearedProxyEnv}), never a normalization derived here.
 *
 * @param policy - the resolved policy to install.
 * @returns a disposer restoring the previous dispatcher and policy, then closing the agent.
 */
function installGlobalProxy(policy: ProxyPolicy): Promise<() => Promise<void>> {
  const previousPolicy = active
  if (policy.source === 'none') {
    // A direct policy mounted over an installed one must actually stop proxying. Recording the policy
    // alone would leave the previous dispatcher as the global one, so a plain `fetch()` would keep
    // tunnelling while `proxyRouteFor()` reported a direct connection — and a layer meant to switch
    // proxying off would be a silent no-op. With nothing installed there is nothing to displace.
    if (previousPolicy === undefined) {
      active = policy
      return Promise.resolve(() => {
        active = previousPolicy
        return Promise.resolve()
      })
    }
    const previousInstalled = installed
    // The dispatcher the proxied install displaced is the direct one this window restores — Node's
    // own default when there was none, which is exactly the pre-install behavior.
    setGlobalDispatcher(previousInstalled?.delegate)
    active = policy
    installed = undefined
    return Promise.resolve(() => {
      setGlobalDispatcher(previousInstalled)
      active = previousPolicy
      installed = previousInstalled
      return Promise.resolve()
    })
  }
  const previousDispatcher = currentGlobalDispatcher()
  const previousInstalled = installed
  const agent = new ProxyDispatcher(policy, previousDispatcher)
  setGlobalDispatcher(agent)
  active = policy
  installed = agent
  return Promise.resolve(async () => {
    setGlobalDispatcher(previousDispatcher)
    active = previousPolicy
    installed = previousInstalled
    await agent.close()
  })
}

/**
 * Resolve this process's proxy policy from `env` and install it.
 *
 * Resolution, reporting, and installation are one operation because no caller needs them apart: the
 * launcher does all three in sequence before the first plugin mounts, and a policy resolved but not
 * installed routes nothing.
 *
 * A value the environment supplies but this package cannot use is reported and skipped rather than
 * thrown: the variable may have been exported for another tool, and a proxy the harness cannot use
 * must not stop the agent from starting.
 *
 * @param env - the launch environment, whose own layering already prefers real variables over `.env` files.
 * @param report - receives one message per rejected value, in the order the values were considered.
 * @returns a disposer restoring the previous dispatcher, policy, and environment.
 */
export async function installProxyFromEnvironment(
  env: EnvLookup,
  report: (message: string) => void,
): Promise<() => Promise<void>> {
  const { policy, diagnostics } = resolveProxyPolicy(env)
  for (const diagnostic of diagnostics) report(diagnostic.message)
  return await installGlobalProxy(policy)
}

/**
 * The environment overlay that removes every proxy name from a spawned child.
 *
 * The scrubbed child base is isolated from the user's network routing, and a harness that replays
 * a recorded session must reach its own fixture server, not the proxy a developer or a CI runner
 * exported; `undefined` is how a spawn removes a name it inherits. The full-access base keeps the
 * user's own `process.env` spellings, which this package never rewrites.
 *
 * @returns one entry per proxy name, each `undefined`.
 */
export function clearedProxyEnv(): Record<string, undefined> {
  return Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, undefined]))
}
