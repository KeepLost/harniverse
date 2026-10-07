# `@deepseek-ai/dsh-client-ui-workspace-editor`

English | [中文](README.zh.md)

The workbench preview's editing occupant: a CodeMirror 6 editor registered into the two `preview-document` holes ui-workspace declares (`workbench.preview.document` for the drawer placement, `shell.overlay.preview.document` for the overlay placement). Composing this package turns editable preview families (code/text/markdown/html/csv/tsv) into manual-save editors over the `workspaceFileWrite` Remote; removing the row returns the preview to its read-only render, byte-identical to the pre-editor surface.

## Editing model

Manual save only — `Ctrl/Cmd+S` inside the editor (the editor is focused, so the shortcut never leaks to the page) and the toolbar button with an `aria-label` naming the file. No auto-save, no encoding conversion action. The editor shows LF-normalized content and restores the file's original line-ending style on save; the Host reproduces the original encoding and byte order mark. Tab size 2, line numbers, undo history, and line wrapping follow the workbench-editor investigation's defaults. Dirty, saving, and conflict states render as text in an `aria-live` region — never a color-only marker.

## Draft account and conflicts

Drafts live in the plugin's own store, keyed by machine/`workspaceId`/path: `{draft, baseVersion, eol, encoding, bom, status, conflict?}` plus the serialized CodeMirror undo history (`EditorState.toJSON({history})`). The account survives overlay↔drawer placement switches (each switch serializes the live editor state and the next occupant restores it, undo history included) and machine switches (registrations re-bind to the new machine while every entry stays addressed under the machine it was edited on; a `beforeunload` guard warns while any draft is unsaved). Saves run their own lifecycle — never through the workbench's request fence, so switching Workspaces mid-save cannot abort it — and a retried save reuses its Host-side `saveId` idempotency.

A lost CAS race (`stale-version`) or an external change observed through the file-level watch (version-compared via `stat`; own-save echoes are suppressed) surfaces the conflict bar: compare changes (a unified diff of disk vs. draft), discard-and-reload, or overwrite the disk version. Unmappable-character and size refusals surface the Host's typed message.

The occupant owns Escape while focus is inside it (the preview's window-capture close defers); a fallen-through Escape asks the owner to close, and the owner confirms before closing a dirty document.

## Dependencies

The CodeMirror pins are exact (`state 6.7.6`, `view 6.43.13`, `commands 6.11.1`, `language 6.12.4`, `search 6.7.2`, plus the minimal language set `lang-javascript 6.2.5`, `lang-json 6.0.2`, `lang-python 6.2.1`, `lang-html 6.4.12`, `lang-css 6.3.1`, `lang-markdown 6.5.2`) and inline into this package's own client bundle — the browser fetches them only when this row is composed, so the workbench's critical path stays free of editor bytes.

## Model Experience

None, as this package is a browser-side editor surface; the model-visible save notice belongs to [`@deepseek-ai/dsh-workspace-file-write`](../../host/workspace-file-write/README.md).

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No editor-code splitting inside the bundle** — the client bundle emits one `client.js` per plugin and has no dynamic-chunk mechanism; CodeMirror bytes load with this plugin's bundle only, which the investigation accepted as the lazy-loading outcome.
- **Dirty drafts survive a confirmed close** — closing a dirty document keeps its draft in the account; reopening the path restores it (an unsaved-changes recovery). There is no explicit discard-on-close action.
- **Draft bound per account** — at most 64 remembered entries per machine (oldest-opened evicted first); file content never enters browser persistence.
- **No `@codemirror/merge` side-by-side merge** — the conflict comparison is a unified diff (the shipped `DiffBlock` primitive); a merge view remains an owner decision.
- **jsdom geometry** — the component specs polyfill `Range` rect APIs; real layout behavior is covered by the assembled browser build.
