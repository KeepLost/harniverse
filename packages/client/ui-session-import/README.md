# `@deepseek-ai/dsh-client-ui-session-import`

English | [中文](README.zh.md)

The "会话导入" settings section and the archive dock: where a user brings official DeepSeek Harness conversations into Harniverse as read-only archives and continues one in a new session. It is a browser-only plugin over the `officialSessionImport` Remote of [`@deepseek-ai/dsh-host-official-session-import`](../../host/official-session-import/README.md) (`ctx.remote.officialSessionImport`) and the `session.continueArchive` RPC of [`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md); the node half registers no host behavior. The section registers its own nav glyph (the download tray) into the keyed `settings.nav.icon` slot under the section id `session-import`.

## Composition

```yaml
# host row (the Remote this section drives) is owned by the web-app bundle
# browser row
- id: ui-session-import
  name: '@deepseek-ai/dsh-client-ui-session-import'
```

The plugin injects the `officialSessionImport` namespace service, so a host that does not mount the import Remote never activates it. It registers into `settings.section` with id `session-import` and order `22`, between IM bots (21) and Voice input (25), and, once the `conversation` service exists, into `conversation.input.dock` with id `session-import-archive` and order `-100`, so the archive notice leads the dock.

## Behavior

- **Scan per machine.** The section scans the targeted machine when it mounts and again whenever the machine target changes, clearing the previous machine's selection and results. It shows the scanned roots, one row per candidate (title, else the first prompt, else "未命名会话"; the source working directory, turns, update time, and size; and the status 未导入 / 已导入 / 有更新), and a collapsed list of logs that could not be offered with their reason.
- **Select and import.** Rows are checkboxes named by their title; "全选未导入" selects every candidate not imported in its current version. "导入到" offers "原工作目录（自动创建工作区）" — the workspace at each source's own directory, registered on demand — and every registered workspace. Importing sends the selection in one `importSources` call, shows each outcome (imported, imported without joining the workspace, already imported, or the failure reason with the Host's detail, plus how many records the lossy mapping omitted), and rescans.
- **Upload.** A file input accepts an official `session.vN.jsonl` or `.jsonl.zstd` file; files over the machine's limit are refused before reading, and the file is sent base64-encoded through `importUpload` into the chosen target.
- **Open.** Each settled outcome offers "打开": the section waits up to five seconds for the archive to reach the session list (the Host announces imports with `host/session-added`), opens it, and closes Settings; a session still missing leaves a notice instead.
- **Archive dock.** On a session whose `sessionImport` projection is non-null, the dock explains that the conversation is a read-only import, shows the source working directory, and offers an Agent preset select (the default preset, then the usable roster from `agentPresets.list`) and "继续对话". Continuing calls `ISessions.continueArchive`, opens the new session, and reports a failure inline. On every other session the dock renders nothing.
- **Inert composer.** For as long as a session scope lives, the plugin raises a composer block on archives through `ctx.conversation.blocks`, so the textarea is disabled with "这是只读归档，点上方的“继续对话”接着聊" as its placeholder while the model seat stays live.
- **Accessibility.** Controls are native buttons, checkboxes, selects, and a file input with labels; each row checkbox is labelled by its title and described by its details; the upload hint is the input's description; statuses use `role="status"` and failures `role="alert"`; the dock is a labelled region.

## State and wiring

`createSessionImportStore()` declares the section's shared viewing state (scan phase, latest scan, selection, target, import progress, last results, and the latest local refusal); `createArchiveDockStore()` declares the dock's (preset roster, pending continuations, per-archive failures). Components read through `useStore` and write through the declared actions only. The operation layer (`controller.ts`) drives the Remote, the preset roster wire, and the sessions face and publishes outcomes through those actions; the section's machine target arrives through the inject `hooks` compartment. The `/client` entry exports only `apply`, `inject`, and types.

## Model Experience

Indirectly, through the archive dock's `session.continueArchive` call; [`dsh-session-import`](../../session/session-import/README.md) owns the continuation seed the model sees.

#### KV Cache effect

None of its own; a continuation builds its own prefix from the seed when its first turn runs.

## Known Limitations and Deferred Work

- **Re-importing an updated session adds an archive** — a "有更新" candidate imports as a second archive; the section does not offer to remove the older one.
- **No per-candidate target** — one import batch lands in one target choice; mixing source directories and an explicit workspace takes two batches.
- **Uploads are read whole in the browser** — the file is base64-encoded in memory before sending, so very large logs cost browser memory up to the machine's limit.
