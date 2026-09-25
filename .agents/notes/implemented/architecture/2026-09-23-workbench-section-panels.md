# Agent Note: The terminal and browser panels moved into the Workspace workbench as contributed sections

Status: implemented

English | [中文](2026-09-23-workbench-section-panels.zh.md)

## Problem

The terminal and browser panels were center views opened by sidebar footer triggers: two panels that belong to the session occupied the whole center column over the conversation, and their entry points lived in the sidebar's foot beside Settings — placement that made a coding agent's shell feel like a browser chrome feature. Harniverse is a coding agent, not a shell around a browser or terminal; the panels are session-bound tools, and the product decision was to move both into the session's Workspace workbench, as peer tabs beside Files/Changes/Search, keeping the session binding and each panel's own multi-tab strip (pages, terminals) intact inside its section.

## Decision

ui-layout declares two list holes, `workbench.section.tab` and `workbench.section.panel` (owner share: `current`, `select`, `request`), mirroring how `center.view` is declared — the shell owns the composition point, the workbench entry declares them as children, and the frame carries the selected section in the layout store with `ctx.layout.openWorkbenchSection(section, request?)` as the one-gesture open-and-select the markdown link router calls. ui-browser and ui-terminal register one tab and one body each; a body mounts only while its section shows (the wrapper returns null otherwise, so the panel lifecycle — page surface, input attachment, xterm mount — rides section activation exactly as it rode center-view occupancy before). Selection state moved from the workbench's per-Workspace account to the layout store, which also makes `ILayout` the single route for programmatic opens; the per-Workspace section memory is gone and the section tabs share the frame. The workbench renders sections with or without a resolved Workspace (the Files/Changes/Search bodies and tabs still need one), and blank sessions resolve their Workspace in both the workbench and AppFrame's right-region gate. The hero Workspace chip has two native buttons: the folder/name opens the same layout workbench as the active-session header utility, while the arrow anchors the existing picker. The name is disabled without a resolved session Workspace or during a pending switch; a cwd-derived label during list loading is display-only. The input dock retains its other contributions without a separate workbench button. The keyboard roving moved from per-button handlers to the tablist container so arrows cover contributed tabs; the sidebar footer triggers, their components, view stores, and exports were deleted; the scheduler keeps its own center view and footer trigger.

## Alternatives considered

Keeping the panels as center views and only moving the triggers into the workbench was rejected: the panels would still cover the conversation, which is the placement the decision removes. Declaring the section holes in ui-workspace (the workbench's owner) instead of ui-layout created a genuine project-reference cycle (ui-conversation needs the hole for the link router while ui-workspace already depends on ui-conversation's conversation slots), and the `center.view` precedent — shell-declared composition point — was the better home anyway. Persisting the selected section per Workspace (as the old store field did) was rejected in favor of one fact source in the layout store; the markdown-link request rides the same store verbatim, as `centerViewRequest` does.

## Consequences

The two panels are workbench sections: their tabs sit beside Files/Changes/Search, their bodies render inside the workbench's tabpanel (multi-page/multi-terminal strips intact), and they are reachable from blank sessions through the Workspace chip. The sidebar footer keeps only the scheduler trigger and Settings. Markdown links open the browser section through `openWorkbenchSection`, declining to the reader's own browser when the section is absent or the preference says `device`. The scheduler's center-view slot is untouched.

## Testing

`pnpm run test:gui` (5259 passed, one skipped); per-file coverage gates on ui-layout, ui-workspace, ui-browser, and ui-terminal; `pnpm run typecheck`; focused terminal, browser, markdown-link, lifecycle-chrome, and workspace-workbench scenarios pass. Both Web E2E shards and the coverage job pass in PR #144 CI. The local `smoke-real` transport-retry case times out during setup; its cause remains unresolved, and the earlier comparison did not rebuild baseline artifacts.
