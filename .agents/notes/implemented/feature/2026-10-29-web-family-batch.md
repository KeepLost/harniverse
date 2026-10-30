# Agent Note: Wave-5 web-family batch absorption

Status: implemented

English | [中文](2026-10-29-web-family-batch.zh.md)

## Problem

The owner disposition of 2026-10-29 accepted the remaining wave-5 row-17 product choices as one batch (see `UPSTREAM-ABSORPTION-REVIEW.md`, Wave-5 row 17 disposition): eight web-family increments plus `keep-assistant-replies`, absorbed onto Harniverse's own contracts rather than upstream's newer carrier packages (`ui-chat`, `ui-dockkit`, `file-upload`, and the rich-text editor do not exist downstream).

## Decision

- **Composer image upload staging on add.** Images pasted/dropped/picked now upload when added — background XHR with progress, per-item state `uploading → ready{ref} | error{reason}`, remove cancels, transport failures retry, host refusals are remove-only with their reason on the rail thumbnail, and submit waits for every image draft naming the first failure. New route `POST /api/attachment/upload-image` (same trust fence/auth/`harniverse.operate` as the file route; streamed read bounded at `min(maxImageBytes, maxMessageImageBytes)`; media-type allowlist; `validateImage` → `saveImage`). Adaptation: Harniverse images are content-addressed durable `ImageAttachmentRef`s, so the official per-Session in-memory receipt registry is replaced by the refs themselves (session-agnostic, no rebind needed). The prompt RPC part union gained the additive arm `{ type: 'image'; ref: ImageAttachmentRef }` (host verifies via `readImage`, digest-checked, fail-closed; staged bytes count toward `maxMessageImageBytes`; the count covers both arms). **The session log is unchanged** — `durablePromptContent` still cites the canonical stored-ref block, pinned by the prompt-image-refs fixture test; the session-contract digest baseline is untouched.
- **Text-derived message quotes.** New package `dsh-client-ui-message-quotes` ports the official recognition/render half: `quote-text.ts` near-verbatim (explicit `>` blockquote spans), a `SentUserTextRule` (`id: 'quote'`) over the `sentUserTextRules` seam created for credential masking, and a literal blockquote render. Sent messages are ordinary Markdown; no quote metadata persists and the session format is unchanged. The selection-insert half rides R33 with the rich-text editor it requires.
- **Chat flow-gap.** The official 6→4px process-row tightening is adapted onto the flat 16px column rhythm: `--dsh-chat-process-gap: 4px` between adjacent process rows, `--dsh-chat-response-gap: 12px` before an assistant reply, everything else 16px (negative-margin sibling rules on `data-chat-flow-kind`). Pinned by `chat-flow-gap.client.spec.ts`.
- **Tab-strip scroll-to-active.** `ui-workspace`'s `TabStrip` gains `scroll-behavior: smooth` scroll-to-active with an 8px edge inset, plus the official jump-then-glide semantics: last `scrollLeft` recorded per workspace account (module WeakMap), restored instantly on remount, first placement jumps.
- **Docs long-table filter.** Website theme module (`website/.vitepress/theme/`) ported near-verbatim: ≥10-body-row tables gain row-level search, clear, empty status, sticky header offset, print rules; zh/en copy; spec `scripts/verify-doc-site-table-filter.spec.ts` wired into `docs:check`. Correction recorded: this is a docs-site feature, not chat tables.
- **Session-list summary projections.** Correction recorded: the item is a wire-payload subset, not a rendered summary line. `ProjectionDefinition.summary?: boolean` (default true) opts a key out of listing rows; `summaryKeys()` on the registry; `cachedSnapshot(meta, keys?)` filters cache reads; `session.list` rows serve the summary subset while every open face (history tail, push frames, explicit reads) is unchanged. Excluded keys: `todos`, `sessionStats`, `tokenUsage`, `contextPressure`, `contextBreakdown`, `plan`.
- **New Session blank reuse.** Investigated against the official hardening: Harniverse already reuses blanks with strict preset matching, preserved drafts, and self-correcting stale-blank mirrors; the divergences are deliberate (the host header is the immutable sole authority). Pinning tests added; no production change.
- **ui-user-questions iteration.** Answered question batches render as a `question-reply` conversation chat node (right-aligned bubble, collapsible, copy); the composer gains 3-line CSS clamp disclosure with aria-labeled expand/collapse and wrapped option descriptions, reset per step; optionless questions stay answerable and long questions never hide submit. zh/en only; no locale expansion, CUA hooks, or timed-question changes.
- **keep-assistant-replies — recorded commitment, no code.** Harniverse has no turn-fold model (R33 unscheduled; every assistant reply is permanently visible). `foldedReplies: 'all'` is the required default when the own fold design lands.

## Alternatives considered

- **Porting upstream's carrier packages wholesale** (`ui-chat`, `ui-dockkit`, `file-upload`, the rich-text editor) was rejected: Harniverse deliberately does not carry those architectures; every item lands on existing seams (`sentUserTextRules`, the tab strip in `ui-workspace`, the A5 upload plumbing, the conversation-node registry).
- **Official's per-Session in-memory receipt registry for staged images** was replaced by the content-addressed durable `ImageAttachmentRef`s Harniverse already mints — session-agnostic, no rebind machinery.
- **A type-level narrowing of list-row projection values** (upstream's `SessionProjectionSummaryValues`) was judged low-value downstream: list blocks seed the same higher-seq-wins store as open faces, so a type split would guard nothing the runtime does not already enforce.
- **Host-side blank-reuse re-verification** was not added: the Harniverse host header is the immutable sole authority (deliberate divergence from the official preset-switch recording), so the client-side strict match plus self-correcting mirror is the faithful encoding.

## Consequences

- `session.list` rows shrink by the summary-excluded keys; clients treat absence as capability-absent, exactly as before. Open faces are unchanged.
- The prompt RPC part union gains the additive `{ type: 'image'; ref }` arm; the session log and the v0 digest baseline are unchanged (pinned by the prompt-image-refs fixture test).
- Composer images upload at add time; refused uploads keep the Host's reason and never silently drop from a send.
- Browser goldens for the question composer and the new `question-reply` node were refreshed (`DSH_SNAPSHOT=refresh`); replay is green.
- `keep-assistant-replies` binds the future R33 fold design to the `foldedReplies: 'all'` default.

## Verification

Focused suites: `ui-message-quotes` 15, `ui-workspace` tab spec 76, table-filter spec 6 + docs trio 49, `ui-conversation` 626, `session-projection`/`session-projection-cache`/`todo`/`plan-mode`/`session-stats`/`token-meter` 262, apiproxy projections 19, runtime workspaces 28/382, `ui-user-questions` 71, staging-affected four-package sweep 2008, `test:gui` 7691 passed; `pnpm run build` green (240 artifacts); oxlint clean on changed files; css tokens/classes gates green; session-contract digest baseline unchanged. Goldens refreshed under `DSH_SNAPSHOT=refresh` for the intentional composer/chat-node output changes; replay green.
