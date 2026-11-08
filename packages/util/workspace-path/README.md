---
description: "Browser-safe Workspace path display helpers and the authenticated file media URL."
kind: "package-library"
---

# @deepseek-ai/dsh-util-workspace-path

English | [中文](README.zh.md)

## Summary

Client surfaces display workspace paths consistently: the final segment names a workspace, the root is stripped only for paths inside it, and absolute file paths address media through the authenticated file route. The library derives everything from strings; it touches no filesystem.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`workspaceTitleOf(path)` reads the final non-empty segment for both separator styles. `relativizeToCwd(text, cwd)` strips the workspace root only from paths rooted inside it; everything else displays unchanged. `fileMediaUrl(base, path)` addresses a decoded absolute file path through the `api/file` route of an HTTP(S) application base or `dsh-app://app/`, refusing unsupported transports, non-absolute paths, UNC roots, and control characters.

<a id="model-experience"></a>
## Model Experience

None, as string derivation registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Upstream's `dsh-resource://file/…` address grammar (`sessionFileAddress`, `absoluteFileAddress`, `parseFileAddress`, `fileAddressFor`) plus `resolveWorkspacePath`, `abbreviateHomePath`, and `pathPartsOf` are deferred: no Harniverse surface consumes them today; they return with the surfaces that need them.
- Display spelling never canonicalizes case or separators; Windows paths display in their authored spelling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Absorbed from upstream `packages/util/workspace-path` (wave-6 batch D) as the consolidation home for helpers previously duplicated in `ui-conversation`'s `file-paths.ts`, `ui-tool`'s `tool-call-model.ts`, and `client-runtime`'s session titles. `tests/file-media-url.spec.ts` is the upstream suite verbatim; the index suite carries the upstream rows for the shipped functions.

</details>
