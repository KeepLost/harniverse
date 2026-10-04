# Agent Note: TSV preview and desktop `@path` drops

Status: implemented

English | [中文](2026-10-04-tsv-preview-and-desktop-path-drops.zh.md)

Scope: `packages/client/ui-workspace` (`src/client/preview-kind.ts`, `src/client/stores.ts`, `src/client/WorkbenchPreview.tsx`, `src/client/locales.ts`), `packages/client/ui-conversation` (`src/client/input/file-paths.ts`, `src/client/input/facade.ts`, `src/client/service.ts`, `src/client/contract/slots.ts`, `src/client/apply.ts`, `src/client/skeleton/InputBar.tsx`, `src/client/locales.ts`), `apps/desktop/src/preload.ts`

## Problem

Blueprint rows R30/R31 (item X13): the workbench previewed CSV tables but not TSV, and the composer accepted only images from drops and paste. Upstream previews spreadsheet families we rejected (XLSX/XLS stay refused per the recorded disposition) and turns desktop drops into `@path` references; the web upload path was to stay unchanged.

## Decision

- **TSV rides the CSV arm.** `previewType` maps `tsv` to the existing table family; `parseCsvPreview` takes the delimiter (`,` default, `\t` for TSV) with quoted-field and embedded-delimiter handling unchanged, and the bounded-rows truncation stays identical. One dictionary key (`workbench.tableEmpty`) covers both formats with a `{format}` parameter; CSV copy renders exactly as before.
- **Desktop intake is capability-gated, not platform-guessed.** The composer treats a client as local-Host only when the connection seam reports loopback AND `hostDescription.canOpenPath` — the same already-client-visible facts `ProducedFiles` reads; no UA sniffing. Non-local clients keep today's image-only behavior byte-for-byte.
- **`@path` chips through the preload bridge.** The Desktop preload exposes `harniverseHostPaths.pathFor` (Harniverse's name for upstream's `__DSH_HOST_PATHS__`; Electron `webUtils.getPathForFile`) on the http(s) branch — the desktop shell loads the app over `loadURL`, not `file:`. On a local client: whole-batch validation runs before any mutation (a busy composer or an unsupported entry refuses atomically), directories without a bridge refuse with localized desktop-only copy, pathless files and images still upload, and named files/folders become relativized `@path` reference chips inserted through one `paste-begin` transaction (single undo for the batch; chips delete and serialize exactly like existing occurrence chips through ui-reference's codec). A mixed drop splits: images upload, the rest become chips — neither silently disappears. Web (non-local) non-image drops keep the existing refusal copy; the A5 upload path is untouched.
- **Folder drops stay one chip.** A dropped folder inserts a single `@path` reference for its path (no recursive traversal); the official grammar's directory-tail quoting is ported in `file-paths.ts` alongside `relativizeToCwd` and `workspaceTitleOf`.

## Verification

`packages/client/ui-workspace/tests/workspace-workbench.client.spec.tsx` (TSV beside every CSV case: dispatch, parser, quoted tab-fields, comma-in-TSV isolation, clipping, empty copy), `packages/client/ui-conversation/tests/input-file-paths.client.spec.ts`, `input-files.client.spec.ts`, `input-bar.client.spec.tsx` (desktop intake describe: non-local parity, split, insertion point, refusal toasts), `apply-inject.client.spec.tsx` (batch atomicity). Scoped tsc and lint clean.
