# dsh-http-proxy

English | [中文](README.zh.md)

The **process-wide outbound proxy policy** for the harness: resolve one policy from the launch environment (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`, either casing), install it behind the dispatcher symbol Node's global `fetch` resolves, and hand every other surface — spawned children, the web-fetch transport — the same routing answer.

Node's built-in `fetch` ignores the proxy environment on its own, so every harness request would connect directly no matter what the user exported. One install covers LLM adapters, web search, and any plain `fetch()` caller without touching their code: the launcher (`dsh` profile boot) resolves and installs the policy before the first plugin mounts, resolving from the launch-environment snapshot rather than `process.env`, which is what lets a proxy declared in a `.env` layer work — `NODE_USE_ENV_PROXY` cannot, because Node samples the environment at process start.

This is a **library, not a plugin**: transport policy has one answer per process, so there is nothing for a composition to mount, swap, or scope. Harniverse carries it **natively** — no `undici` dependency: the installed dispatcher speaks the dispatch contract global `fetch` already uses, and every proxied hop runs through the one shared tunnel builder.

## API

```ts
import {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  requestViaProxy,
} from '@deepseek-ai/dsh-http-proxy'
```

| Export | Role |
|---|---|
| `installProxyFromEnvironment(env, report)` | Resolve the policy from the launch environment, report every rejected value, and install it behind the global-fetch dispatcher. Returns a disposer restoring the previous dispatcher, policy, and environment. |
| `proxyRouteFor(url)` | How one request must be sent, answered from a single read of the active policy: `{ proxied: true, proxy }` or `{ proxied: false }`. |
| `requestViaProxy(proxyUrl, url, options)` | The one shared proxy hop: absolute-form request for `http:` targets, `CONNECT` + TLS for `https:`. Returns the final response and the handle that aborts the whole hop. |
| `proxyEnvironmentForChild()` | The overlay a spawned child needs: the resolved proxy names plus `NODE_USE_ENV_PROXY`, restoring user-written values so `curl` keeps the SOCKS proxy this package refused. |
| `clearedProxyEnv()` | One `undefined` entry per proxy name, for a replay that must reach its own fixture server. |

## Policy semantics

- **Resolution order**: a scheme's own variable wins, then `ALL_PROXY`, then — for HTTPS only — the HTTP proxy. A rejected slot (malformed URL, SOCKS, unsupported scheme) keeps that scheme direct; the diagnostic and the route agree, and no fallback routes a request somewhere the user never asked for.
- **Diagnostics never carry values**: a proxy URL may embed `user:password`, so messages name the variable only.
- **Loopback is never proxied** (`localhost`, `127.0.0.0/8`, `::1`, IPv4-mapped forms), and every bypass list is merged with those entries.
- **`NO_PROXY` matching**: comma/space-separated; an entry matches the host and every subdomain; an optional `:port` must equal the effective port; `*` bypasses everything; CIDR is not matched.
- **No proxy exported**: nothing is installed and no environment name is touched — global `fetch` keeps Node's internal default transport byte-for-byte.

## Consumers

- `dsh` profile boot installs the policy at launch and disposes it at shutdown.
- `dsh-web-fetch-http` consults `proxyRouteFor` and routes proxied URLs through `requestViaProxy` (no local DNS pinning — the proxy resolves); loopback and bypassed URLs keep the pinned direct transport.
- `dsh-subprocess` overlays `proxyEnvironmentForChild()` in `scrubbedParentEnv()`, so child Node processes inherit the parent's routing.
- LLM adapters (`dsh-llm-pi-ai`, discovery and provider streams) need no change: their `fetch()` calls resolve through the installed dispatcher.

## Model Experience

Indirectly, through outbound routing only: proxying changes which network path a model request takes, never its model-visible vocabulary.

#### KV Cache effect

None; routing changes carry no request-prefix changes.

## Known Limitations and Deferred Work

- **No connection pooling** — each proxied hop opens its own socket (per-request tunnels; `agent: false`), and direct URLs under an active policy that displaced no dispatcher also take a per-request socket. Node's internal default transport keeps its pooling when no policy is installed.
- **HTTP/1.1 only through tunnels** — the CONNECT arm negotiates no ALPN, so an origin that requires HTTP/2 multiplexing cannot be proxied yet.
- **Upgrade requests are refused on proxied routes** — WebSocket-style upgrades never arrive from `fetch`; a tunnel for them would need its own protocol handling.
- **Worker threads are not served** — a worker has its own `globalThis` and dispatcher; installing here does not reach it, and model-authored script runtimes must not receive a proxy URL that may carry credentials.
