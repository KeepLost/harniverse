# dsh-lazy-require

English | [中文](README.zh.md)

Caller-relative lazy loading for CommonJS-compatible Host dependencies. One tiny function: wrap an eager top-level native import into a first-use load, so image-free or PTY-free startup never pays for a binding it may never use.

## What it does

`createLazyRequire` builds a zero-argument loader from Node's `createRequire`, pinned to the caller's own `import.meta.url` so published package layout keeps resolving correctly. Only successful loads are cached; a failed load stays uncached, so a corrected installation can be retried by the next call.

```ts
import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

// First use loads the native binding; every later call returns the same module.
const metadata = await requireSharp()(input).metadata()
```

The generic parameter preserves the caller-supplied module type; keep the `import type` side so the dependency itself stays out of the module graph until first use.

## Scope and limits

CommonJS-compatible dependencies only — an ESM-only package needs an async `await import()` factory owned by its caller. Static bundlers cannot see through the `createLazyRequire()` call, so a packed/browser build must keep the dependency name discoverable as a literal request; none of the current consumers ship a packed bundle.
