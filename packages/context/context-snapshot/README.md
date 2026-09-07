# @deepseek-ai/dsh-context-snapshot

English | [中文](README.zh.md)

Durable user-role runtime-context snapshots assembled from the system-prompt contexts plane. What `dsh-system-prompt` registers as dynamic context (the deployment persona, sandbox or plan policies, any contributing plugin) reaches model history only through this plugin's messages, so every model-visible update is reconstructable from the Session log.

Requires `ctx.agents` and `ctx.systemPrompt` (`inject: ['agents', 'systemPrompt']`). The default `dsh-base` composition mounts it directly after `system-prompt`.

## Snapshot lifecycle

Retained state is derived from the Session log on every decision — never cached in memory. An owned message is a `user/message` whose source is `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-context-snapshot' }`. Folding the visible owned messages in event order yields the effective state: a cleared marker empties it, a complete snapshot replaces it, a partial snapshot overwrites only the names it carries. Records whose `sections` cannot be read as `{ name, text }` pairs (resumed, forked, or externally written seeds) contribute nothing — neither state nor the published flag.

Emission compares the currently assembled sections (`renderContextSections`) against that state:

| Condition | Message |
|---|---|
| No usable owned record ever existed, sections empty | none |
| Name set changed (added or removed section) | **Complete** — every section |
| Only some section texts changed | **Partial** — only the changed sections |
| Sections empty while a snapshot was published | **Cleared** marker |
| Unchanged | none |

## Timing

Three paths share the emission rules:

- **`agent/pre-step`** — after the waterfall decides, a due message is prepended to the entering batch, ahead of the claimed user input, so the model reads current runtime context before the material it must act on.
- **`agent/request`** — when compaction completes inside the request waterfall and shadows the retained snapshot, a fresh Complete (or Cleared) message is appended durably; the request history is rebuilt from the surface, so the retried request carries it without new user input. Failures are logged and the request proceeds.
- **`compaction/end`** (no `error`) while the agent is idle — manual `/compact` runs no step, so a contained async recovery appends the due message durably. In-flight turns and requests own their recovery through the paths above.

## Model Experience

### Complete snapshot

#### What the model sees

One user-role message opens with the supersession framing line, then renders every contributing context in assembly order.

##### Complete message

```markdown
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

<one block per contributing context, in assembly order>
```

#### Token effect

One retained user message per publication; a session with unchanged runtime context pays it once. Republished completes repeat every section.

#### KV Cache effect

Append-only history: each publication follows the reusable prefix, so earlier tokens stay intact and the new snapshot with later turns forms a new suffix.

### Partial snapshot

#### What the model sees

The partial framing line announces an update, followed by only the sections whose text changed; the durable source carries `partial: true`, and sections it does not carry remain as last published by the preceding visible runtime-context snapshots.

##### Partial message

```markdown
Current runtime context has some updates.

<only the sections whose text changed>
```

#### Token effect

One retained message proportional to the changed sections instead of the whole context — the saving over a complete republication grows with the unchanged remainder.

#### KV Cache effect

Append-only, like the complete snapshot.

### Cleared marker

#### What the model sees

One short line states that no runtime context applies and earlier snapshots are void.

##### Cleared message

```markdown
Current runtime context: none. Earlier runtime-context snapshots no longer apply.
```

#### Token effect

One short retained message, emitted once when the last published state empties (the final context disposed or runtime context suppressed).

#### KV Cache effect

Append-only, like the complete snapshot.

## Known Limitations and Deferred Work

- **Partial identity is per-section text** — reordered sections with identical name set and texts produce no update; a same-named context whose meaning drifted without a text change is invisible to the diff.
- **No cross-message merge on the wire** — the model reconstructs current state by reading the snapshot sequence; the plugin does not rewrite or compact its own earlier messages.
- **Compaction recovery is best-effort after idle** — a `compaction/end` that lands between idle checks is recovered at the next step or request boundary; no durable marker tracks a missed recovery.
- **Request-boundary recovery recomputes one assembly** — the recovery assembles the prompt plane once inside the request waterfall; a provider whose context contribution is expensive pays that cost again on the compacted retry.
