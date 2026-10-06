# Agent Note: Recall pending steering before the claim boundary

Status: implemented

English | [中文](2026-10-06-recall-pending-steering.zh.md)

## Problem

The Host could already remove or edit a pending `next-step` occurrence through `session.updateQueue`, but the Web offered no entry point: the pending-steering bubble carried Copy only, while QueueDock recalled only `next-turn` rows. Two gaps followed. Steering parked by Stop (`keepInbox`) silently rode into the next send alongside fresh input, with nowhere to withdraw it. And a refused `queue-item-not-found` meant three different things — the loop claimed the batch, another client already recalled it, or the session is cold — so the UI could only guess "may have started sending". The operation also mutated injected context rows (approval notices, task completion) that no user action owns.

## Alternatives considered

- **Move the commit point so recall works until the request leaves (admission watermark).** Rejected for this change: it rewrites the agent-loop commit ordering and forces a new durable event across a dozen consumers, and it couples to the planned upstream 0.2 absorption. The claim boundary already covers the common cases (tool waits, question waits, parked steering).
- **Client-side filtering of non-user rows instead of a host refusal.** Rejected: any other client or script could bypass it; the decision belongs in the operation that makes it.
- **Recall-with-time-window and undo-send.** Rejected: the boundary is causal (claim), not temporal; a window can neither guarantee unreadness nor help an idle synchronous send.
- **Batch recall ("recall all").** Rejected: sequential non-atomic removal needs an explicit product decision (Stop already owns bulk clearing).

## Decision

- **Recall window ends at the claim** (D1a, D3a): the button withdraws an occurrence only while it is still pending. After the claim the UI reports the model-read refusal and guides to Stop (D5a); no time window, no post-request undo, no batch action (D6a).
- **Host tightens `session.updateQueue`** (D7a): a `next-step` occurrence refuses edit/remove/steer with the new `queue-item-not-user` error unless `source.kind === 'user'`; `next-turn` keeps admitting plugin follow-ups unchanged. `queue-item-not-found` details now carry the occurrence's durable `status` — `claimed`/`settled` (model-read), `discarded` (already recalled), or `{ state: 'unknown' }` for a cold session the operation never resumes — so clients route copy by fact instead of guessing.
- **The pending-steering bubble recalls** through a new `ChatViewInjected.recallSteering(itemId, content)` composed in `apply.ts`: the Host remove runs first, then the composer refills with the `splitFileHandleText`-stripped plain text only on the success verdict (D2b). A non-empty draft is preserved while the text goes to the clipboard with a notice; image/file attachments recall but report as not restored; a failure never refills, so a lost race cannot resurrect the text in the composer. The action stays available while parked after Stop, hides for addressed subagents (the QueueDock mutability rule), and the chat domain still never imports the input domain.
- **One wording for one semantic** (D8a): QueueDock's delete action is "recall" everywhere, and every refused recall — dock row or bubble — reports the durable lifecycle instead of the generic started-sending guess.
- **Out of scope, recorded as Known Limitations** (D9a, D10a): continuable-subagent and cold-session pending residue stay unrecallable; removal does not retire attachments; recall does not erase the admitted body from the log, export, or attachment authorization.

This note supersedes the "Copy but without Fork, edit, or delete actions" clause of the pending-steering presentation in [the steer-action note](2026-07-30-web-queue-steer-action.md); that note remains active for the strict-steer decision itself.

## Consequences

- Recall is safe against the claim race by the existing synchronous critical section: remove-first produces a `canceled` splice, claim-first produces the lifecycle-carrying refusal. The idle wake remains a zero-width window (synchronous claim before `prompt` returns).
- A recalled message leaves no transcript trace (the `canceled` splice is the only record), but its body stays readable in the log's insertion splice: recall means "never sent to the model", not erasure.
- QueueDock's recall failure copy keys off `QueueMutationError.status`; callers of the throwing `ConversationController.updateQueue` see the same structured rejection, and the non-throwing `removeQueueItem` exists for recall choreography.

## Verification

- `packages/host/apiproxy/tests/api-proxy-status.spec.ts` — next-step user recall returns `discarded`; non-user next-step rows refuse every action with `queue-item-not-user` while a plugin `next-turn` row stays mutable; lost races return `claimed`, `discarded`, and cold `unknown` lifecycles in the details.
- `packages/client/ui-conversation/tests/` — `queue-dock.client.spec.tsx` (recall wording, status-differentiated notices), `chat-view.client.spec.tsx` (recall visible running and parked, hidden for subagents, busy-gated, addressed with the occurrence identity and content), `chat-apply.client.spec.tsx` (refill on success only, handle-stripping with the attachment notice, clipboard past a non-empty draft, model-read refusal without refill), `service-orchestration.client.spec.ts` (unchanged steer-race convergence past the new error shape).
- `apps/web/tests/steering.e2e.ts` — keyless replay recalls a question-parked interjection from the bubble (the next request excludes it; the composer refills) and recalls steering parked by Stop before the next send; the pending-steering ARIA goldens pin the new recall action.
