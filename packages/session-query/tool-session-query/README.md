# @deepseek-ai/dsh-tool-session-query

English | [中文](README.zh.md)

Model tools over `ctx.sessionQuery` with id-bound exact observations and optional discovery/search filtering. The package registers four discovery, search, and unified inspection tools, and the shipped base and Agent Profile compositions mount it by default.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `maxSearchResults` | `100` | Maximum authorized non-self hits collected across internal provider pages |
| `searchTimeoutMs` | `30000` | Cooperative deadline attached to indexed discovery and both full-text search tools |
| `messageTailLimit` | `10` | Default folded current-message count returned by the `session_inspect` messages view; at most 50 |
| `logTailLimit` | `20` | Default complete raw-event count returned by the `session_inspect` history view; at most 50 |

The caller comes exclusively from `ToolExecution.exec.agent`. Exact targets are selected by opaque session id and every returned observation must retain that id; `cwd` is only an optional exact discovery/search filter, where omission leaves the deployment-visible corpus unconstrained and `null` selects sessions without a cwd. Discovery and search never expose provider cursors, offsets, page sizes, or a model-controlled limit. Because one operation consumes generation-bound provider cursors internally, `session_find` and both content-search tools execute exclusively with sibling tool calls; `session_inspect` opts into parallel execution.

`session_find` discovers sessions by current title, creation time, raw-event activity time, and session metadata; its results contain no content-match event or snippet. `session_search` remains content full-text search and returns the strongest matching event with its seq and snippet; sub-word CJK terms match and compacted turns stay searchable. Broad discovery always omits the caller session, while passing exactly one `session_ids` entry returns every matching event in that one session instead — the caller's own session is an allowed single target and stops immediately before the active step. Requested parent ids are deduplicated and checked for existence before indexed work. `session_inspect` dispatches summary status, folded messages, raw history, one event window, or lineage through one bounded read-only contract and never resumes cold sessions. Its messages view reads only the folded current surface; history and event render complete raw events including shadowed and log-only records. Adding `seq` to lineage inspects that event's replacement and source relationships.

Every trusted `ctx.sessionQuery` call crosses one model-boundary sanitizer. Caller cancellation is checked first and preserved exactly. Available corpus and provider diagnostics, including safely inspectable nested causes, are logged internally on a best-effort basis; unprintable failures use a fixed log placeholder. Diagnostic formatting and error classification are independently guarded, so an unprintable cause cannot escape or prevent a safely classified outer error, while unsafe classification or logging falls back to the fixed `SESSION_QUERY_TOOL_FAILED` code and message. Local argument-validation and authorization errors retain their precise tool-owned messages.

The package deliberately performs no byte or character truncation and does not import a spill backend. Deployments that need bounded inline output mount `@deepseek-ai/dsh-spill-policy`, which can replace the rendered text after execution while retaining the complete result.

## Model Experience

### System prompt

#### What the model sees

The model receives one fixed prior-history guidance section.

##### Prior-history guidance

```markdown
Session research: find prior sessions by title, creation time, or activity window with session_find, which returns session metadata only. Find sessions by content wording with session_search, which returns each session's strongest matching event with seq and snippet; any language matches, including sub-word CJK terms, and compacted turns remain searchable. Pass exactly one session_id to session_search to list every matching event in that one session instead; the current session is an allowed target and stops before the active step. Read one session with session_inspect: summary status; messages (the current folded view — compacted turns are absent); history (complete raw events, compacted originals included); one event; or lineage. The current session's compacted summaries are recovered with compaction_history_search then compaction_history_expand. Use session_message to continue a known ordinary session or direct subagent session; inbox acceptance does not mean completion. Search and find results are cursor-free.
```

#### Token effect

One fixed concise section is present on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the plugin and guidance text are unchanged.

### Tool schemas

#### What the model sees

The model sees the [three generated session-query schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query): `session_find`, `session_search`, and the unified `session_inspect` contract. Discovery/search filters add fixed schema tokens; `cwd` is accepted as an optional filter but is not rendered in results.

#### Token effect

Four fixed read-only schemas are sent on each request while visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each successful call emits one plain-text block. Find results include current titles and activity metadata without content-match fields; content-search results include titles and best-match excerpts. Inspection history and event views include complete event JSON, messages remain the folded current model-message surface, and lineage includes all authorized relationships. The generic spill policy may replace oversized inline text with its preview, opaque locator, and retrieval hint.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; `maxSearchResults` bounds search-hit count.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- Search returns at most the deployment cap and asks the model to narrow its query when more matches exist; it offers no continuation token.
- Mounting this opt-in Consumer exposes deployment-visible session discovery; session ids are bearer-like opaque references and must remain unguessable.
- Custom compositions without the generic spill policy accept complete trace and event payloads inline.
