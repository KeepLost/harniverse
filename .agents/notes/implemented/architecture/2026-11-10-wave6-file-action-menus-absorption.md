# Agent Note: Wave-6 file-action menu absorption

Status: implemented

English | [中文](2026-11-10-wave6-file-action-menus-absorption.zh.md)

## Problem

The wave-6 batch D plan closed with the file/image context-menu contributions: the capability core (`ctx.fileActions`) landed in an earlier slice, but the menu contributions — copy-image, download, save-as on the `file` and `image` target families — still lived only upstream, and they needed the stat/byte-window reads that stage (d) just added to the workspace face.

## Decision

Absorb upstream `ui-file-actions/src/client/context-menus.tsx` as the contribution, with three recorded adaptations:

- **Session-to-workspace mapping.** Upstream's contribution calls a session-keyed remote (`ctx.remote.workspaceFiles.stat(sessionId, …)`). Harniverse's face is workspace-keyed, so the contribution resolves the target's `sessionId` through the runtime's workspace list (`items.find(item => item.sessionIds.includes(sessionId))`) and calls `ctx.workspaces.statFile`/`readFileBytes`; byte windows arrive as base64 and decode to a Blob client-side. A session no workspace accounts for keeps its rows but disables them without a stat call. This widening is why `IWorkspaces` (the outward contract) now declares the two stage-(d) methods, and the test double follows.
- **No reveal.** Upstream's save notice carries a "reveal in file manager" action backed by `session.openWorkspacePath`. Harniverse saves are client-side browser downloads, so host-side reveal has no target (the stage-(d) decision); the notice keeps its saved/downloaded/downloadStarted branching and drops the action. The reveal locale keys stay dormant in the shipped dictionary.
- **Icons.** The three glyphs are upstream artwork re-expressed as inline components (`IconSaveOutline16` is new in ui-primitives; copy and download already existed), registered on the `contextMenu.icon` keyed seat under `file-actions.copy`/`download`/`save`.

The plugin entry now injects `contextMenus`/`slots`/`locale`/`workspaces` (upstream also injects the two remotes we do not carry); the capability core, `files.ts`, `types.ts`, and `locales.ts` remain upstream verbatim.

## Alternatives considered

**Wait for target emitters.** No shipped surface emits `file`/`image` targets yet, so the contribution is dark until file cards / an image renderer land. Porting now keeps the d3 menu machinery and the stage-(d) reads exercised by their first real consumer contract instead of re-opening the seam later.

**Session-keyed reads on the host.** Rejected: harniverse has no session→host-workspace binding on the inspection API; the client runtime already owns that mapping, and pushing it host-side would duplicate it.

## Consequences

Right-click save/copy becomes available the moment a surface emits `file`/`image` targets; the rows gate on stat availability and the Desktop adapter (`canSaveAs` offers the native picker, images keep both download and save-as). The two locale dictionaries ship eight keys of which three (reveal family) are dormant until a host-files save mode exists. `IWorkspaces` widening is a public-contract act recorded here and in the runtime README's inspection sentence (stage (d) edit).
