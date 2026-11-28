# Agent Note: Entry re-creation, the smoke renderer probe, and the env-credential hint

Status: implemented

English | [中文](2026-11-28-ci-rerun-root-causes.zh.md)

## Problem

Three defects behind most of the CI reruns of the last ten days, counted from the failed attempts of every workflow run between 2026-11-19 and 2026-11-28:

1. **A Loader entry created again under a just-removed id started while the removed Fiber was still unloading.** `EntryGroup.remove` deleted the entry and started its Fiber's disposal without keeping the promise, and `EntryGroup.create` registered the new entry at once. The notification-http composition spec removes the row in one Include refresh and restores it in the next, and the re-created backend opened the `notification_http` storage domain before the removed one had closed it: `DomainError: domain 'notification_http' is already open`. Three reruns — the Windows native lane twice, the Linux coverage lane once — and two failures in twelve local runs under twelve busy CPU loops. A config edit of the same entry is not affected: `Entry.update` restarts the Fiber, and `_unload` awaits every disposer before `_reload` starts the next instance.
2. **The clean-install smoke judged the authenticated-API probe on one attempt.** `authenticatedApi` issued one `executeJavaScript` probe under a ten-second bound and failed the qualification when it went unanswered, although `probeRenderer` documents an unanswered probe as "not answerable right now", never a failed qualification on its own. Six `desktop / macOS arm64` reruns, all in the restart phase: the application's own requests had been admitted, the heartbeat kept beating, and in two captures the deferred-start requests landed eight to ten seconds after the page came up — a stalled renderer or Host, not a broken one.
3. **The models-settings e2e captured the add card before the env-credential detection landed.** The hint under the API-key field reads "not confirmed" until its detection answers, and `captureStableAria` accepts two equal frames; an unresolved state that stalls is stable. Two web e2e reruns pinned `环境凭据状态尚未确认` where the golden holds the "not detected" sentence.

## Decision

- **`EntryGroup` keeps a removed Fiber's teardown until it settles, and `create` waits for the one under its id** (`vendor/loader/src/config/group.ts`, local modification V30 in `vendor/README.md`). The record disappears when the teardown settles, and a rejected teardown does not fail the re-created entry because Core has already logged it. An id with no teardown in flight takes the upstream path with no added await. The notification-http spec is unchanged: removing a row in one refresh and restoring it in the next is what an operator's second save does, and it is the regression test of this behavior.
- **`answeredRendererProbe(deadlineMs, attempt)` re-issues a probe until it answers or the deadline passes** (`apps/desktop/src/smoke.ts`). `authenticatedApi` gives it thirty seconds over attempts of the same ten-second bound, logs each unanswered attempt with the main frame's loading state, and still fails at once on an answered `false`. The receipt means what it meant: an authenticated `session.list` answered, now within thirty seconds instead of ten.
- **The e2e waits for the settled hint before it captures** (`apps/web/tests/models-settings.e2e.ts`).

## Alternatives considered

- **Let the composition spec await the removed Fiber before restoring the row** — rejected: the product keeps the race. Two saves inside the teardown window of a deployed profile would leave the re-created entry failed until the next config change, for every plugin that frees a resource in its disposers.
- **Let `DomainFacility.open` wait for a closing predecessor** — rejected: `DomainFacility` is not a Cordis `Service`, so `open` cannot see the calling Fiber, and it could wait only once `Domain.close` had started — in the backend's disposer, after the shutdown drain, which is most of the window. It would also serve domain holders alone, where the Loader change serves every plugin.
- **Lengthen the smoke probe's single bound** — rejected: one longer wait cannot tell a stalled frame from a broken one any better than a short one, and thirty seconds of re-issued probes answer the same question the receipt asks.
- **Teach `captureStableAria` to hold on the "not confirmed" copy** — rejected: it would couple the shared e2e scaffold to one plugin's locale; the settled read belongs at the capture site, as `waitForSettledModelTrigger` already does for the composer's model trigger.

## Consequences

- An entry restored inside the teardown window of its previous instance starts once that instance has released what it held. The restore waits as long as the teardown takes, bounded by each plugin's own shutdown budget; a plugin whose teardown never settles holds its id, where upstream would have started a second instance beside the first.
- `EntryTree.await()` and `loader.await()` still do not see a removed entry's teardown: the removed entry is no longer in the tree. A caller that needs the teardown itself awaits the Fiber's `dispose()`.
- The macOS desktop smoke passes when the restart-phase probe is unanswered for up to thirty seconds; a failure past that point reports each unanswered attempt and the main frame's loading state in the job's diagnostics, which is the evidence the six earlier captures lacked.
- The models-settings capture is independent of when the env-credential detection answers.

## Testing

- `scripts/cordis-loader-recreate.spec.ts`: an entry whose disposer releases a seat after a delay is removed in one group reconciliation pass and restored in the next, the way Include reconciles a file; the sequence is taken, released, taken, and the re-created entry is `ACTIVE`. On the old tree the second instance is refused while the seat is still held.
- `packages/notification/notification-http/tests/loader-composition.spec.ts` (unchanged): two failures in twelve runs under twelve busy CPU loops before the change, none in twelve after.
- `apps/desktop/tests/smoke.spec.ts`: a probe answered on its third attempt resolves to the answer and a refusal is returned at once; a probe no attempt answers fails at its deadline after three attempts.
- `apps/web/tests/models-settings.e2e.ts`: the ten-scenario file passes in local replay with the added wait.

## Related

Four single failures in the same window stay unexplained and unchanged: `ptc-runtime-node/tests/runtime.spec.ts` "cancels a live program and closes its managed process with {}" (a 600 s timeout on the Windows native lane), `ptc-runtime-node/tests/persistent.spec.ts` "terminates after unacknowledged abort in a loop after await and recreates empty state" (the text written before the stop was missing from the output, Windows native lane), `apiproxy/tests/client-handler.spec.ts` "stops consuming when the caller aborts" (a 5 s timeout on the macOS informational lane), and `apps/web/tests/subagent-conversation.e2e.ts` "cold-resumes the original subagent while its ordinary fork stays active" (a 30 s catalog wait). None reproduced outside CI; each needs its platform to diagnose.
