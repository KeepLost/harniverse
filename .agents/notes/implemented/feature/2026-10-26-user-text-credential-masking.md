# Agent Note: Credential display masking for sent user text

Status: implemented

English | [中文](2026-10-26-user-text-credential-masking.zh.md)

## Problem

A user who pastes an API key or token into a message shares it with everyone who later sees the screen or a screenshot: the message text, the copied text, and the model input all carry the secret, and only the first is a display concern. The wave-5 survey recorded official's `dsh-client-ui-secret-mask` (row 7) as an absorb candidate; official's `ui-secret-mask` draws each recognized credential masked in every sent-user-text surface, with a per-value reveal control.

## Decision

Port the official plugin as `packages/client/ui-secret-mask` (owner decision 2026-10-26), preserving its semantics exactly: masking changes only what is drawn; the message text, copy actions, and model input keep the original characters.

The recognizer (formats, tables, scanner, masks) is ported near-verbatim: a prefix-pruned linear scanner with per-text memoization, no allocation before a match returns, format-only recognition (provider key and token prefixes, JWTs, private key blocks, address passwords). The composition differs because our client fork predates official's UserText factory and slot registry:

- `dsh-client-ui-conversation` owns a new sent-user-text seam: a reactive module registry inside its client package, exposed to other plugins through the `conversation` service face (`ctx.conversation.sentUserText`) — a cross-package value import would fail the client bundle purity gate by design. The user bubble consumes it through `useSyncExternalStore`.
- The bubble collects non-overlapping matches across registered rules (earliest start first), renders plain segments with the existing reference-chip decoration, and matched ranges through the rule's `Render` component. Sent and admitted steering text is interactive (eye control per value); pending pre-admission echoes are not.
- `dsh-client-ui-secret-mask` registers dictionaries plus one rule whose `Render` is the ported `SecretText`; the shipped Web composition mounts it, and removing the row draws credentials as written.

## Alternatives considered

**Official's UserText factory and node slots.** That machinery belongs to official's `ui-chat`/`ui-renderer` architecture, which we do not carry; rebuilding it for one consumer would add a parallel text pipeline to our conversation view.

**Scan in the composer and store masked text.** Rejected by definition: the logged text must stay the single truth, so masking can only be a display projection.

**Match configured secrets instead of formats.** A configured-secret list cannot know which secrets exist, invites a false sense of coverage, and couples the client to the credential store; formats are public knowledge and require no state.

## Consequences

- Only sent user text is masked (assistant output, tool results, and the composer draft render as written); the composer draft stays unmasked by the owner decision of 2026-10-30 — masking un-sent input would interfere with the user's judgment of what they typed, and the composer is not a secrets channel (agent-relevant secrets belong in a separate file the agent reads).
- The performance character is preserved and now gated: `benchmarks/user-text.bench.ts` holds the per-document budget (measured medians under 1 ms per ~256 KiB document) so a backtracking regression cannot land silently.
- Verification: 31 recognizer tests (official's format table ported), the component suite (mask/reveal/interactive semantics), the plugin registration suite, the conversation seam suite, and the web-app composition build.
