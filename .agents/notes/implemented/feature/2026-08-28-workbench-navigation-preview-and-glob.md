# Agent Note: Workspace workbench navigation, overlay preview, and glob filters

Status: implemented

English | [中文](2026-08-28-workbench-navigation-preview-and-glob.zh.md)

## Problem

The read-only Workspace workbench mixed a foreign vertical activity rail with a narrow navigation column and a document pane that consumed the remainder of the right region. Opening a file therefore squeezed the conversation and the navigator together rather than letting file content own attention. Files, Changes, and Search did not share one navigation hierarchy, and file search could only apply a case-insensitive filename substring; it could not limit a query to `*.py`, one source subtree, or an explicit exclusion.

The workbench also consumed custom-property names that the shared theme never defined. Browsers silently dropped declarations containing those missing values, so borders, hover fills, and label colors could diverge by skin without a build error.

## Decision

The Session-header entry is a 32px capsule using the same border, typography, spacing, and hover vocabulary as the adjacent Session-log action. Inside the workbench, Files, Changes, and Search are three peer tabs along the top edge. Rows use the sidebar's 34px height, 8px radius, and 22px tree-indent rhythm. Feature CSS consumes semantic properties defined by `dsh-client-ui-theme`; `verify-client-css-tokens` rejects undefined governed declarations outside the theme and fallback-less `--dsw-*` or `--ds-*` references that the theme does not define.

Opening a file sets `previewOpen` in the Workspace-partitioned workbench store. A second `dsh-client-ui-workspace` registration shares that store handle and renders the preview into `shell.overlay`. `dsh-client-ui-layout` publishes the resolved sidebar and right-track widths as `--dsh-frame-sidebar-width` and `--dsh-frame-right-width`, then passes generic `rightMode`, `rightOpen`, and `rightDrawer` occupancy facts to overlay entries. The preview is therefore present only while the workbench is the visible docked occupant; its bounded width stays inside the conversation column and its right edge meets the workbench's left edge without importing the layout store or observing shell DOM. The preview enters from the left and covers part of the conversation. It remains mounted while dismissed, is inert and absent from the accessibility tree while closed, moves focus into a non-modal region while open, restores a prior focus target only while that target remains visible and operable, and consumes Escape before a nested drawer can also close the workbench. Closing or switching the workbench immediately withdraws the overlay and clears preview visibility while retaining document tabs.

When the workbench is a full-frame drawer, `shell.overlay` is inert by shell contract. The same preview component therefore renders inside the workbench and replaces its navigation chrome as a whole-panel switch. Closing the preview retains tabs; closing the final tab also closes the preview.

`workspace.files.search` accepts optional `include` and `exclude` lists, each bounded to 20 non-empty patterns of at most 200 characters. Patterns are case-insensitive: `*` and `?` stay within one path segment, `**` crosses separators, `{a,b}` selects alternatives, and character classes support ranges and negation. A pattern without `/` matches a basename at any depth, a pattern with `/` matches the whole Workspace-relative path, and a trailing `/` covers a directory subtree. Root markers `/` and `./` are accepted. An absent or empty exclude list uses Host-owned dependency, cache, and build-output defaults; a non-empty list replaces those defaults so a caller can intentionally inspect a normally skipped subtree. Search retains its 200-result and 20,000-entry scan bounds and prunes excluded or unreachable directories before descent.

## Plugin boundaries

The layout package owns occupancy, drawer resolution, and the one CSS geometry publication. The Workspace package owns navigation, preview state, and both slot contributions; components receive only owner shares, framework hooks, store actions, and injected callbacks. The Host API contract owns wire bounds and the shared glob compiler used by the Host and deterministic client fixture, the Host inspector owns traversal, and the React-free client runtime only normalizes optional lists and forwards cancellation. No component imports another plugin's implementation or reads Cordis context.

## Alternatives considered

**Define compatibility aliases for the missing CSS properties.** Rejected because it would preserve invented vocabulary and let future feature CSS bypass the repository's semantic token contract. Migrating consumers and checking every client stylesheet removes the silent failure instead.

**Keep Search inside Files or retain the vertical rail.** Rejected because include/exclude fields and result state make Search a complete peer workflow, while a side rail spends scarce horizontal width and conflicts with the workbench's top-level information hierarchy.

**Keep preview docked beside navigation.** Rejected because it keeps competing content visible after the user explicitly opens a document and shrinks the conversation instead of allowing a dismissible content surface to cover it. The overlay preserves the navigation account without forcing simultaneous presentation.

**Read the layout store or mutate the shell grid from the Workspace plugin.** Rejected because either route crosses plugin ownership and makes presentation depend on another package's internal state or DOM writes. Owner props carry occupancy; one CSS custom property carries alignment.

**Add a general-purpose glob dependency.** Rejected because the wire contract intentionally supports a small fixed syntax. A local compiler keeps accepted syntax, bounds, pruning, and tests under the Host package's ownership without widening through dependency upgrades.

## Consequences

File content covers the conversation while open, which deliberately hides conversation context until the user dismisses the preview. Narrow and wide layouts preserve one interaction model instead of maintaining a split-pane variant. Explicit excludes replace default skips, so a user who enters a narrow exclusion assumes responsibility for dependency and build trees that the defaults normally prune.

The CSS check covers the repository rather than only the workbench, so existing dead aliases in other client packages are mapped to current semantic tokens in the same change. Focused layout, store, component, runtime, schema, Host traversal, and glob-compiler tests pin owner-share geometry, focus containment, Workspace isolation, pattern syntax, default exclusions, cancellation, and wire bounds.
