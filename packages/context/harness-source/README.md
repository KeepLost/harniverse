# @deepseek-ai/dsh-harness-source

English | [中文](README.zh.md)

Registers the `harness:source` dynamic prompt context (order −99, immediately before `app:web-surface` at −98 in compositions that mount both): a single paragraph naming this Harniverse implementation checkout's absolute root, stating that the checkout location and the current working directory are separate values that may differ, directing the model to `pwd` for the working directory, and scoping the checkout to inspecting or extending Harniverse itself. The DSH relationship and third-party disclaimer are not here; the fixed order −100 harness identity opener of [`dsh-system-prompt`](../../core/system-prompt/README.md) owns them.

Requires `ctx.systemPrompt` (`inject: ['systemPrompt']`). The checkout root is derived inside the package (`HARNESS_SOURCE_ROOT`, exported for tests and snapshot normalization) — four hops up from this package's `src/` or `lib/` entry, which lands on the repository root from either plane. The context registers whenever the plugin is mounted; it is not gated by any surface's configuration, because naming the implementation checkout is surface-independent. The `dsh-web-app` bundle mounts it in every Web composition.

## Model Experience

### Checkout-root context

#### What the model sees

One paragraph names the checkout root and separates it from the working directory.

##### Checkout-root paragraph

```markdown
The Harniverse implementation checkout is at <absolute repository root>. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend Harniverse itself.
```

#### Token effect

One short paragraph per session through the next `dsh-system-prompt` runtime snapshot; constant per process.

#### KV Cache effect

Static for the process lifetime, so the paragraph never invalidates an assembled prefix; the runtime-snapshot path appends it without rewriting history.

## Known Limitations and Deferred Work

- **The root is a module-load fact** — `HARNESS_SOURCE_ROOT` is derived once from this package's own location; an installed or relocated copy reports that copy's root, and a composition that relocates the checkout mid-process is not re-read.
- **No trailing-separator guarantee beyond `fileURLToPath`** — consumers normalizing snapshots must treat the exported string as opaque and replace it wholesale rather than re-deriving it.
