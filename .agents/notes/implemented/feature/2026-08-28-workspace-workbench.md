# Agent Note: Plugin-native read-only Workspace workbench

Status: implemented

English | [中文](2026-08-28-workspace-workbench.zh.md)

## Problem

Workspace inspection was split between a small details-column tree and a separate conversation view. The root directory waited for an expansion gesture, selecting a file changed shared state without navigating to the preview, Git data had no Workspace account, and remounting or switching Sessions could leave the visible tree disconnected from the selected file. The presentation also had no secure path for images or PDFs and no top-level layout contract for a wider working surface.

The workbench needs to remain a read-only plugin contribution. It cannot modify the shell's DOM or grid outside the slot system, expose Host file URLs, follow symbolic links, persist inspected content, or let a late request from one Workspace publish into another Workspace's view.

## Decision

`dsh-client-ui-layout` declares a root-scoped `workbench` slot beside the existing session-scoped `details` slot. Both occupy one physical right region and are mutually exclusive through `LayoutController`. The layout store persists only mode, open state, and independent details/workbench widths under the resolved Workspace id; the sidebar and current account remain transient. Actions taken before the Workspace baseline resolves use a non-persisted provisional Session account and migrate when accounting becomes authoritative. A closed zero-width occupant remains mounted but is inert and hidden from the accessibility tree. The panel becomes a modal full-frame drawer below its mode-specific breakpoint or whenever the concession solve cannot preserve its minimum docked width: the covered shell is inert, CSS-hidden controls are excluded from the focus cycle, focus is trapped and restored, and Escape closes the active occupant. Its keyboard-operable separator resets the active mode's width on double click.

`dsh-client-ui-workspace` contributes one `WorkspaceWorkbench` into that slot, one companion into `shell.overlay`, and one Session-header opener. Workbench and preview registrations share one root-scoped store handle created inside `apply`; it partitions directories, expanded paths, tabs, preview visibility, glob-scoped search, Git state, and active document by Workspace id. Sessions accounted to the same Workspace therefore share one viewing account. The current Session's explicit Workspace membership wins; matching its working directory handles a Session whose registry accounting has not yet arrived. Retired Workspace accounts are pruned only after the Workspace baseline is ready. The [workbench navigation, overlay preview, and glob decision](2026-08-28-workbench-navigation-preview-and-glob.md) owns their presentation and filter semantics.

The workbench loads the root automatically and nested directories lazily. Each Workspace transition aborts the active request set and advances a generation fence; a second request for the same directory, tab, search, or Git account also aborts its predecessor. Callbacks test the request signal and generation before publishing. Re-entering an account removes interrupted loading records so it can request them again. File content, base64 binary data, search results, and Git responses remain browser-memory state and are never selected into persistence.

## Authenticated inspection contract

The existing `workspace.files.*` authenticated RPC family owns file listing, recursive file-name search, UTF-8 reads, and binary preview reads. Search traverses regular directories without following symbolic links, stops at 20,000 scanned entries or 200 results, and accepts bounded include/exclude globs under the [filter decision](2026-08-28-workbench-navigation-preview-and-glob.md). Candidate files use no-follow, non-blocking descriptors so a FIFO or other special file cannot occupy the Host filesystem pool before the regular-file check. Text reads retain the 1 MiB UTF-8 prefix contract. Binary reads accept only allowlisted image and PDF extensions, read the complete regular file up to 8 MiB, and return base64 plus media type; oversized and unsupported files fail instead of producing a corrupt partial preview. Every method requires `harniverse.observe` and is classified as a read.

Git status, commits, and staged or working-tree diffs remain on `workspace.git.*`. The browser exposes no mutation action. The Host binds Linux Git traversal to an opened directory descriptor; macOS and Windows use the canonical path and revalidate the opened descriptor after traversal because their directory-descriptor path semantics cannot provide the same entry point. Every path disables repository-configured fsmonitor and external diff execution, gives Git only a scrubbed environment, and applies a 10-second operation deadline. The Host rejects repositories whose canonical work-tree root or Git metadata escapes the registered Workspace root. Untracked working-tree entries open through the ordinary file preview because Git has no unified diff for content outside the index.

## Preview boundary

Text classification is path-based and selects Markdown, HTML, highlighted code, plain text, or a bounded CSV table. HTML uses a `sandbox="allow-same-origin"` `srcDoc` frame with scripts, forms, popups, and top-navigation still disabled. Images and PDFs use object URLs created from authenticated RPC bytes; the browser revokes each URL when its data changes or its tab closes. PDFs use the same sandboxed frame boundary. Unified Git output is rendered as text with line-role coloring rather than interpreted markup.

Files, Changes, and Search are peer tabs along the workbench's top edge. The active document is a separate focus-managed, non-modal surface: it rides `shell.overlay` and covers the conversation while the workbench is docked, then becomes a whole-workbench switch in drawer mode because the overlay layer is inert there. The [dedicated presentation decision](2026-08-28-workbench-navigation-preview-and-glob.md) records the geometry and alternatives.

## Alternatives considered

**Modify the shell DOM or grid from the Workspace plugin.** Rejected because the resulting presentation would bypass slot declaration, authorization, HMR lifetime, and the layout store. The shell owns physical tracks; the Workspace plugin owns only the `workbench` occupant.

**Keep the file tree in details and the preview as a conversation tab.** Rejected because a single interaction would continue to cross two independently navigated surfaces, and selecting a file would not make the result visible without a second view gesture.

**Scope the workbench store to Session.** Rejected because the renderer creates one store instance per Session-scoped slot. Two Sessions in one Workspace would duplicate tabs and directory state instead of sharing one Workspace account.

**Serve Workspace files from a same-origin HTTP route.** Rejected because it would create a second authorization and content-security boundary, give previews durable URLs, and widen arbitrary file delivery. Bounded authenticated RPC values are sufficient for the supported preview sizes.

**Return truncated binary prefixes.** Rejected because partial image and PDF payloads are generally invalid and make a successful RPC indistinguishable from a corrupt file. The complete-file limit makes refusal explicit.

## Consequences

Workspace inspection has one visible, resizable surface with shared per-Workspace navigation and independent per-Workspace geometry. The API gains two read-only methods and two structured file-preview failures; every carrier, deterministic browser fixture, schema, runtime facade, and test double implements those rows. Base64 increases binary wire size, but the 8 MiB source bound keeps that cost finite and avoids a separate file-serving plane.

The workbench deliberately omits Office document rendering and editing. Text files above 1 MiB display a truncation notice, recursive search can report an incomplete result at either bound, and binary files above 8 MiB require an external application. Focused Host, carrier, runtime, store, component, slot-assembly, and layout checks pin containment, bounds, authorization metadata, cancellation, Workspace isolation, preview selection, and object-URL cleanup. A real Grant-authenticated browser E2E pins desktop and modal mobile interaction plus a normalized ARIA golden.
