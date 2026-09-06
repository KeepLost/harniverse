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
  isSupportedProxyUrl,
  POLICY_ENV_NAMES,
  PROXY_ENV_NAMES,
  proxyForUrl,
  resolveProxyPolicy,
  type EnvLookup,
  type ProxyPolicy,
} from './policy.ts'

/** The active policy, or `undefined` until one is installed. Process-wide, like the dispatcher it tracks. */
let active: ProxyPolicy | undefined

/**
 * The proxy environment as the user exported it, or `undefined` when no policy is installed.
 *
 * Owned by the OUTERMOST install: one layered over the launcher's would otherwise record the outer
 * policy's published values as if the user had written them, and
 * hand every child a normalization the user never asked for.
 *
 * {@link proxyEnvironmentForChild} keeps a value the user set rather than the one this process resolved from
 * it, so a SOCKS proxy `curl` can use is not replaced by an HTTP proxy named for another scheme.
 */
let inheritedProxyEnv: Readonly<Record<string, string | undefined>> | undefined

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

/**
 * Publish a policy through the proxy environment variables, which is how the consumers that read an
 * environment rather than a policy object — every spawned child — see the one resolved answer,
 * including the `ALL_PROXY` fallback and the merged loopback bypass that neither derives on its
 * own. The installed dispatcher does not read these; it routes by the policy.
 *
 * @param policy - the policy to publish.
 * @returns a function restoring every name this call changed.
 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  const previousInherited = inheritedProxyEnv
  inheritedProxyEnv = previousInherited ?? snapshotProxyEnv()
  const published: Record<string, string | undefined> = {}
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = policy[field as keyof typeof POLICY_ENV_NAMES]
    for (const name of names) published[name] = value
  }
  const restore = writeProxyEnv(published)
  return () => {
    restore()
    inheritedProxyEnv = previousInherited
  }
}

/**
 * Read every proxy name this package publishes, as `process.env` holds it now.
 *
 * @returns one entry per name in {@link POLICY_ENV_NAMES}; `undefined` marks an absent name.
 */
function snapshotProxyEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const names of Object.values(POLICY_ENV_NAMES)) {
    for (const name of names) snapshot[name] = process.env[name]
  }
  return snapshot
}

/**
 * Set every proxy name to the value `values` holds for it, removing a name whose value is `undefined`.
 *
 * @param values - the value each name in {@link POLICY_ENV_NAMES} should hold.
 * @returns a function restoring every name to what it held before this call.
 */
function writeProxyEnv(values: Readonly<Record<string, string | undefined>>): () => void {
  // Snapshot EVERY name before writing any of them. Windows folds environment names case-insensitively,
  // so reading the uppercase spelling after writing the lowercase one would read back the value just
  // written and restore the policy instead of the user's environment.
  const previous = snapshotProxyEnv()
  for (const name of Object.keys(previous)) {
    const value = values[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
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
 * installs nothing and leaves the environment untouched: with no proxy exported, `fetch` keeps
 * Node's internal default transport byte-for-byte.
 *
 * @param policy - the resolved policy to install.
 * @returns a disposer restoring the previous dispatcher, policy, and environment, then closing the agent.
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
    // The install underneath published its normalized policy into `process.env`, which is what a
    // spawned child copies. With no policy active there is no normalization to stand behind, so the
    // user's own values return for the window and the outer install's come back when it ends. An
    // install underneath that proxied nothing published nothing, and there is nothing to put back.
    const restoreEnv = inheritedProxyEnv === undefined ? undefined : writeProxyEnv(inheritedProxyEnv)
    // The dispatcher the proxied install displaced is the direct one this window restores — Node's
    // own default when there was none, which is exactly the pre-install behavior.
    setGlobalDispatcher(previousInstalled?.delegate)
    active = policy
    installed = undefined
    return Promise.resolve(() => {
      setGlobalDispatcher(previousInstalled)
      active = previousPolicy
      installed = previousInstalled
      restoreEnv?.()
      return Promise.resolve()
    })
  }
  const restoreEnv = applyPolicyEnv(policy)
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
    restoreEnv()
    await agent.close()
  })
}

/**
 * The proxy environment a spawned child needs.
 *
 * A child inherits the parent environment, which this process rewrote to its own resolved policy.
 * Handing that normalization straight through would replace values the user set for other tools, so
 * each proxy name the user exported is restored to what they wrote: a SOCKS proxy `curl` uses is
 * not swapped for the HTTP one this package fell back to for that scheme.
 *
 * A scheme the user named in neither casing carries the resolved value instead of being removed.
 * Without that the child's routing silently diverges from its parent's: `NODE_USE_ENV_PROXY` does
 * not read `ALL_PROXY`, so a child of a parent that resolved its proxy from that name would connect
 * directly while the parent proxies.
 *
 * The bypass list is always the resolved one. It only ever adds the loopback entries to what
 * the user wrote, so nothing is lost, and the child stops sending its own localhost traffic to a
 * proxy that cannot route it.
 *
 * The flag reaches only Node 22.21+ and 24+; an older runtime keeps that child direct. Such a child
 * also matches bypass entries with Node's own `NO_PROXY` rules, which differ from this package's in
 * their separators and IPv4-range support. Non-Node children (curl, git, pnpm) ignore the flag and
 * read the variables themselves.
 *
 * The flag is withheld when a proxy value the child receives is one this package refused. Node
 * parses `HTTP_PROXY` and `HTTPS_PROXY` under that flag before running the program, and exits on a
 * scheme other than `http:` or `https:` — so a SOCKS value kept for `curl` would stop every Node
 * child from starting. Without the flag such a child connects directly, as this process already
 * reported for that scheme, and `curl` still reads the value it was kept for.
 *
 * @returns names to apply to the child environment, where `undefined` means remove, or an empty
 *   object when no proxy is active.
 */
export function proxyEnvironmentForChild(): Readonly<Record<string, string | undefined>> {
  const policy = active
  const inherited = inheritedProxyEnv
  if (policy === undefined || policy.source === 'none' || inherited === undefined) return {}
  const overlay: Record<string, string | undefined> = { NODE_USE_ENV_PROXY: '1' }
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const resolved = policy[field as keyof typeof POLICY_ENV_NAMES]
    // Naming a scheme in either casing claims that scheme: the child then gets exactly what the
    // user wrote, in the casing they wrote it, rather than a value derived for this process.
    const named = field !== 'noProxy' && names.some(name => inherited[name] !== undefined)
    for (const name of names) overlay[name] = named ? inherited[name] : resolved
  }
  const parsedByNode = [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy]
  if (parsedByNode.some(name => overlay[name] !== undefined && !isSupportedProxyUrl(overlay[name]))) {
    delete overlay.NODE_USE_ENV_PROXY
  }
  return overlay
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
 * A harness that replays a recorded session must reach its own fixture server, not the proxy a
 * developer or a CI runner exported; `undefined` is how a spawn removes a name it inherits.
 *
 * @returns one entry per proxy name, each `undefined`.
 */
export function clearedProxyEnv(): Record<string, undefined> {
  return Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, undefined]))
}
