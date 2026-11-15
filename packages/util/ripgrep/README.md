# dsh-util-ripgrep

English | [中文](README.zh.md)

Packaged ripgrep resolution and subprocess streaming helpers for the Harness — the one place that knows how the bundled `@vscode/ripgrep` binary is reached from every runtime shape.

## Model

- `resolveRgPath()` resolves the packaged binary lazily, once per process: the `@vscode/ripgrep` platform package by default, the unpacked ASAR path under Electron, and an existing `-rg` sidecar beside a single-file executable. A missing or corrupt platform package rejects the call (never package loading), so a partial install fails at the first search, not at composition.
- `spawnRipgrep(subprocess, spec)` starts the binary through the subprocess seam with `--no-config` prepended, so an ambient `RIPGREP_CONFIG_PATH` cannot inject a `--pre` preprocessor. The caller owns argv, exit classification, and cleanup.
- `readRipgrepLines(handle, separator, onLine)` streams UTF-8 stdout records without retaining the whole output; a `false` return terminates the process early (the result-limit stop). Completion, callback failure, and stream failure all await process quiescence; exit codes and cancellation stay consumer-owned.

Consumers: the workspace file search (host `apiproxy`). The `grep`/`glob` model tools keep their own bounded-collect runner in `dsh-tool-fs-search`, which owns the model-facing schema and spill semantics; unifying the two runners is deferred until their exit-classification contracts converge.

## Known Limitations and Deferred Work

- No system-`rg` fallback and no remote execution: the helper resolves only the packaged binary and spawns it through the caller's subprocess provider, which must be co-located with the filesystem being searched.
