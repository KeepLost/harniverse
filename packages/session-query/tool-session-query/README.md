# @deepseek-ai/dsh-tool-session-query

English | [中文](README.zh.md)

Model tools over `ctx.sessionQuery` with id-bound exact observations and optional search filtering. The package registers seven query/read tools, and the shipped base and Agent Profile compositions mount it by default.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `maxSearchResults` | `100` | Maximum authorized non-self hits collected across internal provider pages |
| `searchTimeoutMs` | `30000` | Cooperative deadline attached to both full-text search tools |

The caller comes exclusively from `ToolExecution.exec.agent`. Exact targets are selected by opaque session id and every returned observation must retain that id; `cwd` is only an optional exact `session_search` filter, where omission searches the deployment-visible corpus and `null` selects sessions without a cwd. Search never exposes provider cursors, offsets, page sizes, or a model-controlled limit. Because one search consumes generation-bound provider cursors internally, both search tools execute exclusively with sibling tool calls; exact status, message-tail, trace, and read tools opt into parallel execution.

`session_search` always omits the caller session. Requested parent ids are deduplicated and checked for existence before FTS. A current-session `session_event_search` stops immediately before the step that invoked it. `session_status` never resumes cold sessions, while `session_message_tail` returns bounded finalized model-visible messages from one live-preferred observation.

Every trusted `ctx.sessionQuery` call crosses one model-boundary sanitizer. Caller cancellation is checked first and preserved exactly. Available corpus and provider diagnostics, including safely inspectable nested causes, are logged internally on a best-effort basis; unprintable failures use a fixed log placeholder. Diagnostic formatting and error classification are independently guarded, so an unprintable cause cannot escape or prevent a safely classified outer error, while unsafe classification or logging falls back to the fixed `SESSION_QUERY_TOOL_FAILED` code and message. Local argument-validation and authorization errors retain their precise tool-owned messages.

The package deliberately performs no byte or character truncation and does not import a spill backend. Deployments that need bounded inline output mount `@deepseek-ai/dsh-spill-policy`, which can replace the rendered text after execution while retaining the complete result.

## Model Experience

### System prompt

#### What the model sees

The model receives one fixed prior-history guidance section.

##### Prior-history guidance

```markdown
Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and can be narrowed with an optional cwd filter. Follow a useful hit with session_status, session_message_tail, session_trace, session_event_trace, or session_event_read when you need current activity, recent messages, lineage, relationships, or exact data.
```

#### Token effect

One fixed concise section is present on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the plugin and guidance text are unchanged.

### Tool schemas

#### What the model sees

The model sees the [seven generated session-query schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query), including `session_status` and `session_message_tail`. Search filters add fixed schema tokens; `cwd` is accepted as an optional filter but is not rendered in results.

#### Token effect

Seven fixed read-only schemas are sent on each request while visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each successful call emits one plain-text block. Search results include titles and best-match excerpts; traces include all authorized relationships; event reads include unabridged target JSON. The generic spill policy may replace oversized inline text with its preview, opaque locator, and retrieval hint.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; `maxSearchResults` bounds search-hit count.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- Search returns at most the deployment cap and asks the model to narrow its query when more matches exist; it offers no continuation token.
- Mounting this opt-in Consumer exposes deployment-visible session discovery; session ids are bearer-like opaque references and must remain unguessable.
- Custom compositions without the generic spill policy accept complete trace and event payloads inline.
