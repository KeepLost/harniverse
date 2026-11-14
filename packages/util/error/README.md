# dsh-error

English | [中文](README.zh.md)

`HarnessError` — the dependency-free base class every harness error extends. It carries a stable machine-routable `code` beside the human-readable `message` and optional `cause`, so tool results, retry policy, UI, and replay route on the code instead of parsing text.

## What it is

```ts
import { HarnessError } from '@deepseek-ai/dsh-error'

export class ArchiveError extends HarnessError {}

throw new ArchiveError('archive entry is missing', 'ARCHIVE_ENTRY_NOT_FOUND')
```

- `code` — stable, programmatic, `UPPER_SNAKE_CASE`; route on this, never by parsing `message`.
- `cause` — standard `ErrorOptions` chaining; the original error is preserved for diagnostics.
- `name` — defaults to the constructing class name and is persisted with tool results; assign a string literal in a subclass constructor when a bundler could rename the class.

The tool registry records `{ name, code }` on `tool/result` only for `instanceof HarnessError` failures, so a subclass joins that contract by extending this base.

## Why it is dependency-free

The base previously lived in `@deepseek-ai/dsh-llm`, which sits above packages such as `dsh-attachment` in the dependency graph — those packages re-implemented the shape (or would have created reference cycles) to avoid the edge. With the base in a zero-dependency package, any package can extend it; `dsh-llm` re-exports the same class, so both import paths name one class and `instanceof` checks agree.

## Consumers

- Extend it: one `*Error` class per owning package or domain, each with its own stable code vocabulary (`FsError`/`FS_*` in `dsh-fs`, `ToolArgsError`/`INVALID_ARGS` in `dsh-tools`, …).
- Re-export it: `@deepseek-ai/dsh-llm` keeps the historical import path working.
- Never parse `message` to route a failure; branch on `code`.

## Model Experience

Indirectly, through every extending `*Error` class: a failure a tool body throws records `{ name, code }` on `tool/result`, which retry policy and the client surface route on instead of parsing messages.

#### KV Cache effect

None; the base class never appears in a model request or response.

## Known Limitations and Deferred Work

- **`name` persistence needs literal pinning** — a subclass whose constructor omits `this.name = '…'` falls back to `new.target.name`, which a minifying bundler can rename; subclasses persisted in tool results should pin a string literal.
