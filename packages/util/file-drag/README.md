---
description: "Platform-safe export filenames for original-file transfers on Web and Desktop."
kind: "package-library"
---

# @deepseek-ai/dsh-util-file-drag

English | [中文](README.zh.md)

## Summary

Callers can export files with the same safe filename in Web and Desktop. MIME data fills missing suffixes without limiting accepted file types. The library holds no files or application state.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`resolveDragFileName({ name, mediaType, outputExtension })` sanitizes path separators, reserved characters, and Windows device names. An explicit output suffix wins. Otherwise a compatible existing suffix is preserved, a known conflict is replaced using the declared MIME, and a missing suffix is completed from the maintained `mime` database. Unknown types retain a supplied name or suffix; unnamed content starts with `file`. Names fit 255 UTF-8 bytes, preserving the suffix and whole Unicode characters. Consumers validate wire input before using this typed resolver.

<a id="model-experience"></a>
## Model Experience

None, as filename derivation registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Names describe the caller-declared MIME; this library does not inspect content or infer an unknown format. Explicit suffixes intentionally override MIME naming.
- Upstream's native drag half (the `application/x-dsh-file` transfer token, `DesktopFileDrag` byte-or-resource preparation, and handle lifecycle) is deferred until a Harniverse surface adopts native drags; only the naming contract shipped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Absorbed from upstream `packages/util/file-drag` (wave-6 batch D) with the native-transfer half left upstream; `tests/names.spec.ts` is the upstream suite verbatim.

</details>
