# Agent Note: Client stop and approval keys, the version row, model search, and preparing tool rows

Status: implemented

English | [中文](2026-10-04-client-keys-version-model-search-preparing-rows.zh.md)

Scope: `packages/client/ui-conversation` (`src/client/stop-sequence.ts`, `src/client/stop-shortcut.ts`, `src/client/skeleton/ApprovalPanel.tsx`, `src/client/skeleton/ConversationRoot.tsx`), `packages/client/ui-settings-general` (`src/client/CurrentVersionRow.tsx`), `packages/client/ui-model-selection` (`ModelSelect` search), `packages/client/ui-primitives` (`src/rank-by-name.ts`, `src/MenuGroup.tsx`), `packages/client/ui-tool` (`PreparingToolRow`, `tool-call-arguments-partial.ts`), `packages/client/runtime` (snapshot `phase`, assembler demote-to-update), `scripts/client-build-environment.ts`, `apps/web/tests/preparing-tool-row.e2e.ts`

## Problem

Official-sync blueprint rows R24/R34/R35 (item X14): upstream's client stops a running turn with a double-Escape sequence, answers approvals from the keyboard, shows its release version in General settings, searches the model picker, and renders a preparing row while tool arguments are still streaming. Harniverse's web client had none of these surfaces — the stop button was the only stop affordance, approvals were pointer-only, the General section had no version surface, the model menu had no filtering, and a tool call was invisible until its `tool/call` event dispatched.

## Decision

- **Fixed 500 ms Esc-Esc stop.** `StopSequence` (`stop-sequence.ts`) holds one short-lived first press addressed to a freshly resolved target (session, turn, binding generation, focused region); `installStopShortcut` (`stop-shortcut.ts`) adds one window keydown listener in the capture phase that owns the whole eligibility chain: a bare, non-repeated, non-composing Escape (including the `keyCode 229` IME fallback) that no earlier handler consumed, with no modal or menu open, addressed to an element of one Conversation occurrence — `ConversationRoot` now carries `data-conversation-session`/`data-conversation-region` — while the occurrence's session runs a live open turn with no pending interaction. Approval takeovers (`data-approval-key`), iframes, `.xterm`, and inert subtrees never arm the sequence; a turn end, takeover, session removal, or binding replacement disarms the pending press through a session subscription. The interval is fixed by decision (upstream derives it from its shortcuts plugin's validated Config; this client has no configurable shortcut registry).
- **Approval keyboard parity with IME guards.** While focus stays inside `ApprovalPanel`, Enter allows once and Escape rejects; editable descendants, native button-Enter clicks, and modifier chords keep their own owners. IME handling latches composition start/end and refuses an Enter that is repeating, mid-composition, or the keyup after a composition end (`isComposing` plus the `keyCode 229` fallback), so a CJK confirm never answers the approval.
- **Version row via `DSH_CLIENT_VERSION`.** `scripts/client-build-environment.ts` injects the repository version as the `DSH_CLIENT_VERSION` build define; `CurrentVersionRow` (ui-settings-general) registers on `settings.general.item` (`id: current-version`, `order: 100`) and renders the localized label. Partial builds without the define omit the row rather than guessing.
- **Model search with sticky provider groups.** Catalogs above four entries show a search field in the model pane; `rankByName` (moved into ui-primitives as a shared menu ranker) matches candidate names and optional localized labels as a case-insensitive ordered subsequence — prefix hits first, then the strongest alignment score (boundary and adjacent matches earn weight, gaps cost), then source order. Provider groups stay intact as `MenuGroup` sections with sticky headings driven by `observeStickyMenuGroups` (asynchronous intersection + resize observation; headings stay transparent until a group crosses the viewport top). Empty groups drop out; a catalog that shrinks below the threshold loses its query and highlight so a stale filter never empties a small list; the search field takes focus when the drilled model pane opens.
- **Preparing rows during argument streaming.** A tool call known only from streamed named tool-call deltas materializes as a `phase: 'preparing'` call in the runtime snapshot; ui-tool's preparing arm renders a non-expandable `PreparingToolRow` (`ToolRowState 'preparing'`), with file-mutation and bash variants showing the streamed argument prefix as whole-kilobyte progress through the `tool` namespace dictionary (`useToolCallArgumentsPartial` reads the live partial blocks). The row is presentation only — no dispatched material exists to freeze — and the promoting `tool/call` replaces it with the dispatched row; a preparing row whose turn is interrupted stays hidden rather than half-shown. The snapshot's `phase` is optional (absent means `start`), so pre-existing snapshots and contract consumers stay valid. The assembler accepts this prefix-then-authoritative-event order by demotion: a `'start'` Match for a Context that already owns one demotes to an update, and among pending additions the earliest start-role Match is THE start while later ones demote to replayed updates, so a Definition may promote a streamed prefix on its authoritative event without reordering the log.

## Alternatives considered

**A configurable stop interval through a shortcuts registry.** Rejected: this client has no shortcut-registry plugin; upstream's Config-derived window would import a configuration surface for one constant. The fixed 500 ms window is the decision.

**Account pinning for search results.** Rejected: pinning matching accounts above provider groups would break the provider-grouped identity of the menu; sticky group headings keep the grouping visible while ranking inside it.

**Folding preparing material into the dispatched row state.** Rejected: a preparing call has no frozen call/result slice to project lifecycle from; a dedicated presentation-only row keyed on the live partial blocks is the honest shape.

**Dropping the streamed prefix when the authoritative event lands.** Rejected: the log's append order must stay deterministic; demoting the duplicate start to an update keeps replay identical to live assembly.

## Consequences

Keyboard-only users can stop a running turn and answer approvals without touching the pointer, with IME composition and native button paths deliberately excluded from both. Packaged builds show their release version; source-checkout builds without the define show no row instead of a wrong one. Large model catalogs filter without losing provider grouping. Tool argument streaming is visible from its first delta, at the cost of a snapshot contract field (`phase`) that consumers must treat as optional. Browser-level proof of the preparing row rides the CI e2e lane rather than local verification.

## Verification

- `packages/client/ui-conversation/tests/stop-sequence.client.spec.ts`: two independent presses inside the interval (inclusive endpoint), expiry, and invalidation of the first press.
- `packages/client/ui-conversation/tests/stop-shortcut.client.spec.ts`: eligibility and disarmament end to end — consumed keys, non-Element targets, leaving Conversation, dialogs/menus, cross-region and cross-turn presses, approval appear/disappear, terminal/iframe/approval/inert descendants, lifecycle changes, binding replacement, continuable vs one-shot children.
- `chat-view.client.spec.tsx` / `conversation-node-definitions.client.spec.tsx`: approval keyboard parity and the preparing node contract in the conversation surface.
- `ui-settings-general` `apply.client.spec.ts` / `components.client.spec.tsx`: the version row registration and its define-absent omission.
- `ui-model-selection` `model-select.client.spec.tsx`: search threshold, ranking through groups, sticky headings, and query clearing below threshold.
- `ui-primitives` `rank-by-name.client.spec.ts` (empty query, subsequence and prefix ranking, boundary/adjacency/gap weights, label as second key) and `menu-group.client.spec.tsx` (unique headings, sentinel outside the accessible tree, no synchronous layout reads, asynchronous crossing and clearing).
- `ui-tool` `preparing-rows.client.spec.tsx` / `tool-call-arguments-partial.client.spec.tsx` plus the row/card suites: preparation replaced by the dispatched row, generic title rules, the prefix hook reading only its call.
- `packages/client/runtime` `conversation-assembler.client.spec.ts`: the demote-to-update ordering for prefix-then-start assembly.
- `scripts/client-build-environment.client.spec.ts`: the `DSH_CLIENT_VERSION` define injection and its failure modes.
- `apps/web/tests/preparing-tool-row.e2e.ts` covers the assembled browser behavior and stays with the CI web-e2e lanes (replay mode; record mode needs a key).
