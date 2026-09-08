# @deepseek-ai/dsh-client-authentication

English | [中文](README.zh.md)

The browser authentication capability owns one page-local renewal chain. `BrowserAuthentication` runs before protected plugins load; the lightweight login entry supplies its signed browser-session exchange. The shell transfers that same runtime through an explicit closure to the Cordis `BrowserAuthenticationService` Provider. Consumers use `ctx.clientAuthentication`; disposing its plugin stops and drains the runtime.

Renewal starts at half-life and wakes on focus, visible-tab restoration, and network recovery. Each exchange has a ten-second abort deadline; transient failures retry with backoff capped at ten seconds. Expired credentials and classified admission failures make requests wait for the shared exchange. Individual cancellation ends only that caller's wait. Non-secret snapshots distinguish ready, renewing, recovering, refresh-required, and stopped states; explicit bypass is identified separately.

Same-origin `fetch` retries once only after HTTP 401 with `x-dsh-authentication: required`, which the Host emits before business dispatch. Unclassified 401, 403, network failures, and uncertain write outcomes are not replayed. One-shot request streams are not buffered or replayed. A repeated classified refusal requires a manual refresh; a sealed server or rejected device proof requires renewed authentication or approval. No recovery path reloads the page automatically. Connection's XHR upload carrier uses the same admission/recovery service while retaining progress and cancellation.

The bootstrap exchange callback honors its AbortSignal and settles before `stop()` resolves. Callers clear the authentication Cookie only after this drain. Late request results cannot restore stopped authentication. The service never exposes a Cookie, private key, or signature through observable state.

## Model Experience

None, as browser admission does not change model input or stop a running Host agent.

#### KV Cache effect

None; no provider request or context assembly is involved.

## Known Limitations and Deferred Work

- Browser Cookie changes made outside this runtime are discovered at the next protected request or connection check, not continuously polled. A healthy snapshot is the latest confirmed state, not a promise that the next network request cannot fail.
- Renewal is coalesced per page. Tabs share the browser Cookie but retain independent page lifecycles; there is no cross-tab leader election or persistent outbound message queue.
