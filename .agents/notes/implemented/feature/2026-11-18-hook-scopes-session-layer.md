# Agent Note: tool-hooks — three scopes and the session-held hook layer

Status: implemented

English | [中文](2026-11-18-hook-scopes-session-layer.zh.md)

## Problem

`hook_add`/`hook_remove`/`hook_list` landed with one storage target: the workspace's Claude-Code-dialect project file. That couples a conversation's hooks to a shared workspace artifact — two sessions in one directory silently share (and can clobber) each other's hook installs, nothing binds a hook to the conversation that created it, and there is no scope that follows the user across workspaces. The supervision system already shows the shape this wants: `supervision/mode` and `sandbox/mode` are session-log state — folded on read, replayed on restart, invisible to peer sessions, no external store.

## Decision

- **Three scopes, one tool surface.** `hook_add`/`hook_remove` take `scope: 'session' | 'workspace' | 'global'` (default `session`); `hook_list` reports all three grouped, with the session group carrying a `changeable` gate state. Workspace keeps the project file; global adds the home file (`$DSH_HOME/hooks/claude-code.json`, foreign keys preserved, `maxHooks` counted per store); session lives in the session log.
- **The session layer is log-only durable state** (`hook/config`, declared in `dsh-hook-protocol` beside its `hook/invoked`/`hook/result` siblings): every change appends a complete snapshot — the `todo/write` precedent — so the fold is last-event-wins, compaction-safe, and replay-restorable. `foldSessionHooks(events)` is the single read; the tools use it to validate and to list, exactly as `sandbox/mode` folds.
- **Bridges run the session layer first.** `dsh-hooks-claude-code` folds the session at every hook point and prepends the resulting matcher groups ahead of every file source — the specificity order `session → user → project → plugin → `policy`. Permission outcomes are order-independent anyway (`mergeHookOutputs` takes the most restrictive decision); ordering governs context-injection order, stop-reason narration, and audit order. An explicit `configPath` overrides file discovery only, never the session itself.
- **Subagents inherit once, by seeding.** At `subagent/start`, the parent's folded set is appended to a fresh child's log as one `hook/config` with `source: 'delegation'` (the `sandbox/mode` seeding precedent; the parent is recovered from the scoped event carrier via `carrierKeyOf`). A child that already carries any `hook/config` event is never re-seeded; later parent changes do not propagate to running children. Grandchildren inherit naturally because the parent's own fold already includes its inherited set.
- **Session-scope changes are supervised-only, fail-closed.** `hook_add`/`hook_remove` at session scope require the effective supervision mode (`ctx.get('supervision')` when present, else the event fold, else `unsupervised`) to be `supervised`; the refusal names the remedies (ask the user to switch supervision, or use a file scope). The rule is stated in the tool schemas so the model learns it from the surface itself. File scopes are deliberately unrestricted — they are disk artifacts a user can review, and restricting them would change unrelated behavior.
- **One adapter, under the harness home.** The generated adapter moves from beside each hook file to `$DSH_HOME/hooks/tool-hooks-adapter.mjs` (still content-guarded). File-held entries keep the `<configPath> <hookName>` argv lookup; session entries pass the real command inline after `--run`, so a session hook needs no file at all. Existing entries pointing at older beside-file adapters keep working when those files exist.

## Session-format impact (v0 additive)

`hook/config` is a new merge-extensible, log-only session event (not a surface event, no `surfaceOp`): payload `{ hooks: SessionHookSpec[]; source?: 'delegation' }`. The digest baseline (`docs/session-contract-digest.json`) was regenerated; `SESSION_FORMAT_VERSION` stays `0` under the additive-only policy. Runtime data relations are enforced by the `dsh-hook-protocol` invariant companion at append time: non-empty unique names, portable event vocabulary, non-empty commands, positive-integer timeouts, and the delegation seed only as the session's first `hook/config`.

## Alternatives considered

- **Session state with a file projection** (session as source of truth, file as a materialized copy): requires projection ownership, reconciliation on divergence, and per-session slots (`sid`) in the file to keep concurrent sessions from clobbering each other. Rejected — three isolated stores are strictly simpler than one store plus a cache.
- **A bridge-side service for the session layer** (tool-hooks exposing a provider the bridges inject): adds service topology and an optional-dependency seam for what is, in the end, just a fold over session events. Rejected — the bridge already holds the session at every hook point; reading the log directly keeps `sandbox/mode`'s "no external config store" property.
- **Live-lineage inheritance** (children folding the parent log at dispatch): propagates mid-run parent changes but couples two logs per dispatch and complicates compaction. Rejected for the seeded, copy-on-write inheritance above.
- **Making the simple stdout contract a first-class protocol output dialect** (no adapter for session hooks): cleaner long-term, but it changes the shared codec every bridge depends on. Deferred; the home adapter with inline `--run` reaches the same behavior with zero protocol change.

## Consequences

- Two sessions in one workspace cannot see each other's session hooks; workspace and global files remain the explicit sharing mechanisms, and `hook_list` shows all three with provenance hints (`managed`, positional names, `changeable`).
- A session-scope hook survives restart by replay and survives compaction because only the last `hook/config` snapshot matters; a deleted or corrupted file can never lose a session's hooks.
- Every managed invocation still pays one `node` adapter process; hand-written dialect entries are untouched.
- The supervision gate means an unsupervised conversation cannot re-arm itself with session hooks; it must ask — which is the point.
- The portable vocabulary (`pre_tool` …) and the CC point mapping now live in `dsh-hook-protocol`'s session layer, so a future Codex-dialect session layer has one home for its own mapping.

## Verification

- `packages/hooks` unit suites: 274 tests green; `tool-hooks` and `hook-protocol` src at 100% statements/branches/functions/lines under the per-file gate.
- Session-layer ordering is proven through a real composition: the `hooks-claude-code` bridge test drives the real agent loop with a session-held `prompt_submit` hook plus a file-held one and asserts the session layer's injected context precedes the file layer's in the model request.
- Supervision gating is tested through the executor across all four modes (pinned supervised/unsupervised, service default both ways), the fold fallback, and the fail-closed default; seeding is tested against the scoped `subagent/start` carrier with a real `carrierKeyOf` key.
- Doc gates: catalog/config-catalog/module-graph regenerated with zh mirrors, session-contract digest regenerated and `--check` clean, translation pairing 1344/1344 consistent, package README Model Experience and limitations gates green.
