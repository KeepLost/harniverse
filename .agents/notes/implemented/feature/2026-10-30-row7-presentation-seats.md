# Agent Note: Replaceable presentation seats and exclusive conversation matches

Status: implemented

English | [中文](2026-10-30-row7-presentation-seats.zh.md)

## Problem

Upstream's row-7 client-UI increments left five presentation surfaces hard-wired downstream: the New Session row had no additive seat for per-session options (its worktree entry being upstream's own motivating consumer), every transcript image gallery and the reasoning body rendered through direct imports that a third-party plugin could not replace per domain, and the conversation assembler matched every Definition independently — a business Definition presenting part of a generic Definition's event family on the same target would double-render, with no way to claim the event.

## Decision

Five seats and one dispatch rule, all over the existing slot and assembler seams, per the owner's row-7 dispositions of 2026-10-30:

- `conversation.hero.options` — a root-scoped list at the right end of the hero Workspace row, after the workspace, agent-preset, and model-profile chips. Root scope matches its sibling hero seats (no session exists yet; a choice is staged for the next one), diverging from upstream's session scope for the same reason the preset chip did. The area collapses entirely while empty. Upstream's worktree consumer needs Host APIs that do not exist downstream (`WorktreeService.create` requires a host Agent; `connectWorkspace` does not thread `cwd`), so the seat ships unoccupied — upstream shipped it the same way, filled later by its worktree plugin.
- `conversation.chat.user.images` and `conversation.chat.assistant.images` — two independently replaceable single/session gallery seats, declared by the `user` and `assistant-step` chat-node entries respectively (declaring is claiming), each occupied by the shipped shared `ui-attachment` gallery at priority 100. A lower-priority registration replaces exactly one domain; disposal restores the shipped gallery. Steering bubbles and the pending projection keep the direct gallery (one declarer per seat; the `steering` key cannot co-declare it). The seat is forwarded from the entry component to the plain renderer as a bound render callback — upstream's own forwarding pattern ("domain callers must forward their framework Slot seat to their plain React descendants").
- `conversation.details.tool.images` — the details panel's result-image seat, declared by ui-tool's details entry, same priority-100 occupant over the model-side view. The chat-row gallery inside keyed toolview entries is deliberately not a seat: it renders within other entries' own layout, and a ReactNode-valued owner prop is barred by the reactive-read discipline.
- `conversation.chat.reasoning.body` — the expanded Think body, declared by the `assistant-step` entry; the shipped plain pre-wrap body occupies it at priority 100, and a replacement receives the same text and streaming state without touching the disclosure chrome. Upstream's separate Content Factory is not ported: the shared-atom package (`ui-attachment`) already is downstream's reusable-implementation seam, and the default body is plain text.
- `ConversationMatchResult.exclusive?: true` — a Definition may claim one event for its sole view target. Dispatch evaluates every Definition's match before accepting any, then withholds a claimed event from other Definitions of the same target and suppresses that target's unmatched-event fallback; other targets and target-less Definitions still receive it. Two claims on one target, or a claim from a target-less Definition, throw at dispatch naming the event. No shipped Definition claims today (the answered-question node rides the sent-user-text rules seam and never collided); the capability is open with assembler coverage pinning order independence, withholding, fallback suppression, and both failure modes.

## Alternatives considered

**One shared gallery seat for every image domain.** Upstream rejected this first — a replacement intended for one domain would affect the others; the same argument holds downstream.

**Declare the user-images seat on both the `user` and `steering` keys.** One declarer per seat key is a SlotCore invariant (the second declaration throws); steering keeps the direct gallery instead of duplicating the seat.

**A `tool.call.images` seat rendered inside ToolRow.** ToolRow renders inside the keyed toolview entries' own component trees; reaching it would require forwarding a render callback through owner props, which the reactive-read discipline bars ("route ReactNode content through a slot"). The details panel — whose entry owns its whole body — is the honest seat position.

**Definition precedence (`specific`/`default`) instead of claims.** Upstream evaluated and rejected this too: precedence makes dispatch a ranking rather than a statement of ownership, and two claims fail loudly instead of silently ordering.

**Port the fold-motion or chat-group machinery with the seats.** Both ride the standing B1/R33 rejection of the official turn-fold family; they stay design references for the R33 own design.

## Consequences

- Every seat's shipped occupant registers at priority 100 with the slot system's shadow-and-restore semantics; nothing changes visually while no third party registers, and the browser goldens stay byte-identical (verified by replay).
- The hero row carries an empty, collapsed options area until a consumer exists; the worktree/cwd-at-creation entries wait on Host API widening recorded in the review file.
- Exclusive claims are decided per event from event data; dispatch allocates one extra match array per event with at least one match and stays registration-order independent.
- The model-label seat was already covered: `conversation.input.model` exists, is occupied by `ui-model-selection`, and its render-site replaceability is pinned by the existing input-bar spec — recorded as a collision, no new code.
- Verification: assembler exclusive suite (withholding in both registration orders, cross-target and target-less delivery, fallback suppression, both throw modes); seat-occupant, bridge, thread, and registry benches (default priority, single-domain shadow, dispose-restore, fiber teardown) in ui-conversation and ui-tool; skeleton hero-row placement; full `test:gui` green.
