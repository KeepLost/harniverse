# Agent Note: A browser panel that cannot launch, and a link with nowhere to go

Status: implemented

English | [中文](2026-09-23-host-without-a-browser-and-the-readers-own.zh.md)

## Problem

A deployment reported `No browser executable was found in this execution environment` on the machine it runs on, and the panel had nothing to offer past that sentence. Two separate gaps sat behind one symptom.

The diagnostic named no facts. The controller probes `executablePath`, else `browserCandidates` in order, but the message said neither what it looked for nor that a path is configurable, so the one person who can fix it — the operator of that machine — was told only that the attempt failed. The candidate list was also asymmetric: `microsoft-edge` was probed under its Linux name while Edge's macOS and Windows install paths were absent, so a Windows or macOS host with only Edge installed failed a probe that was meant to cover it.

The worse gap was the link. `ui-conversation` routed a plain left-click in assistant prose into the host browser panel whenever the shell had composed one in, and the panel's availability was never part of that decision. On a host with no browser program every markdown link therefore landed in a panel that could not load anything, and the reader had no way to say "open it here instead" — the destination was reachable from their own machine the whole time.

## Decision

Report the machine's own facts, and let the reader choose the machine.

`noBrowserReason` composes the unavailable reason from what the probe actually looked for — the configured path, or the candidate list — and names `executablePath` as the remedy. Both sites that report an absent browser use it, so `environment`'s `unavailableReason` and `create`'s `browser-unavailable` failure carry the same text. The panel renders that reason under its localized notice, because the localized sentence can name the remedies while only the host knows which names it tried. Edge's macOS and Windows paths join the candidate list, matching the Linux name that was already there.

`MarkdownExternalLinks.open` now returns whether the owner took the destination, and `renderSafeLink` suppresses the anchor only when it did. This is the whole mechanism behind the second half: an owner that declines leaves a plain anchor with its `target="_blank"`, so the destination opens in the reader's own browser through ordinary browser behavior, inside the very click that asked for it. The alternative — calling `window.open` from the owner — would have been a detached window request that popup heuristics block, and the reader would have seen nothing at all.

The choice itself is a durable preference, `ui-conversation.linkDestination`, beside `busyEnter` in the same section and the same General Settings list: `panel` (the default, keeping the host's network position and the reason the panel exists) or `device`. The opener reads it as a live snapshot rather than a value captured at apply time, so a change applies to the next click without a reload. With `device` selected the opener declines every destination, panel or no panel; with `panel` selected and no panel composed it declines too, which is what the old `window.open` branch was trying to express.

Both Settings rows now share `PreferenceSelectRow`: the two preferences present identically, so the shell is one component and each row keeps only its own vocabulary and inject face.

## Testing

`sandboxDisabled`-style truth tables do not fit here, so the evidence is behavioral. The controller suite pins both reason shapes — the probed candidate list and a configured path that does not exist. The panel suite asserts the host's reason renders under the notice, and that a host which said nothing further still shows the notice alone. `MarkdownText` gains the declining-owner case: the anchor keeps `target="_blank"` and the click is not prevented. The conversation apply suite covers the routing decision on every side — no panel, panel, the reader's choice, a republished identical section, and the durable write that follows the live value.

The end-to-end proof is a real tab: the markdown-link scenario switches the preference through the Settings dialog, clicks the link, and waits for the browser context to open a page at that URL while the panel stays absent. The settings-dialog golden was refreshed for the new row.

## Alternatives considered

**Teaching the conversation which hosts have a browser.** The opener could have consulted host availability and declined only when the panel genuinely could not serve the link, with no preference at all. Availability is a per-Session host fact that the panel controller learns when the view first binds a session, so the conversation would have had to acquire it eagerly through a new cross-package signal — and a reader who simply prefers their own browser on a host that *does* have one still had no way to say so. The preference answers both, and it answers deterministically.

**A client-side browser path setting.** The reported message asks for a browser path, and it was tempting to let the panel user type one. The executable lives on the host and is a deployment fact: `executablePath` is validated plugin `Config` reached through a patch layer, and letting a client choose which program the host executes would hand a browser-side surface a decision about host process execution. The panel names the key instead.

**Opening the tab from the owner.** Keeping `open(url): void` and calling `window.open` when the panel cannot serve the link needs no contract change, and it is what the code did before for the no-panel case. It fails exactly when it matters: the call happens after the click has been cancelled, so the browser treats it as an unrequested popup. Declining is both smaller and more honest — the owner says "not mine", and the platform does what it always does with a link.

## Consequences

`MarkdownExternalLinks.open` is a breaking signature change for markdown owners inside this repository; every implementation returns a boolean now, and an owner that forgets loses interception rather than failing loud. The type makes that a compile error, which is where it belongs.

A reader on `device` never reaches host-local destinations from prose — a link to the host's own `localhost` opens against their machine's `localhost` and fails or, worse, hits something of their own. The Settings description states the tradeoff, and `panel` remains the default precisely because the host's network position is the panel's whole value.

The conversation plugin now owns two durable fields in one section, so its settings scope is bound once in `apply` and shared. A third preference should follow the same path rather than binding a second scope for the same namespace.
