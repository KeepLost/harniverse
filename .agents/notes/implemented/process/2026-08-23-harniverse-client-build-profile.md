# Agent Note: Harniverse client build profile and artifact binding

Status: implemented

English | [中文](2026-08-23-harniverse-client-build-profile.zh.md)

## Problem

Harniverse produces browser artifacts through two paths that do not contain one another: Vite builds the authenticated Web shell into `apps/web/dist`, while the shared tsdown preset builds every dynamically loaded client plugin into `packages/*/*/lib/client.js`. A build-time value replaced in only one path would give the same business expression different results depending on the package it lives in, and browsers have no Node `process` to read at runtime.

Release packing consumed whatever browser files happened to be on disk. A default build followed by a release pack request, a partial plugin rebuild, or an edited bundle produced publishable tarballs with no evidence that their browser files came from one complete build of one declared product identity. Harniverse also needs a release identity distinct from official DeepSeek Harness, which the inherited placeholder titles did not provide.

## Decision

`DSH_CLIENT_*` is the build-time namespace whose values may be embedded in browser artifacts. Business code reads a static property such as `process.env.DSH_CLIENT_TITLE`; set values are inlined as strings and unset names evaluate to `undefined`. The name itself declares publicity, so credentials, owner identity, Grants, capabilities, and Host-only paths must never use it. Authentication and authorization remain entirely runtime plugin decisions; a build profile never selects who may connect or what a browser session may do.

The Vite config and the shared tsdown client preset call one define generator, so both artifact paths receive identical values. The generator emits exact substitutions for `DSH_CLIENT_*` only and reduces every remaining `process.env` read to an empty object, leaving browsers with no `process` global, no dynamic key lookup, and no environment enumeration.

`DSH_BUILD_CLIENT_PROFILE` is the non-public selector that requests a named profile. The `harniverse` profile is exactly `DSH_CLIENT_BUILD_PROFILE=harniverse`, `DSH_CLIENT_TITLE=Harniverse`, and `DSH_CLIENT_COMMIT_HASH` carrying the seven-character source revision. `pnpm run build` embeds the caller's own public values and uses none when the caller sets none; `pnpm run build:harniverse` is the cross-platform equivalent of the CI and release artifact build and replaces inherited public values with the profile, so a developer environment cannot leak into a release build.

A complete root build writes `.harniverse-build/client-build-environment.json`, recording the exact public environment plus a SHA-256 digest over the sorted paths and bytes of the Vite output and every dynamic client bundle and source map. `release:pack --family dsh` requires that record to exist, to match the Harniverse profile at the current revision with no additional public value, and to still describe the artifacts on disk. The vendored framework family publishes no browser variant and accepts any build tree.

## Alternatives considered

**Replace values only in Vite.** A dynamic plugin's `lib/client.js` is fetched as an independent script and never enters Vite's module graph, so the expression would survive into a browser with no `process`.

**Expose every `DSH_*` value.** Host, test, and CI variables already use that prefix and may carry credentials or local paths. The narrower prefix keeps publication intent auditable.

**Rename the namespace to `HARNIVERSE_CLIENT_*`.** The prefix is an inherited build mechanism rather than an official brand, and renaming it would leave downstream packages maintaining two incompatible client build interfaces for the same purpose.

**Give browsers a complete `process.env` object.** That would permit build-environment enumeration and turn a compatibility shim into a runtime API; exact static substitution carries build choices without it.

**Hash only the Web shell.** Harniverse composes its critical and deferred boot aggregates at runtime from the dynamic client bundles, so a shell-only digest would accept a rebuilt or edited plugin.

**Let release packing trust the working tree.** Version and payload checks prove nothing about which environment produced the browser bytes, which is exactly the confusion a published artifact must not carry.

## Consequences

Both artifact paths carry the same string for a given public value, an unset read is `undefined`, non-public values cannot reach browsers through this mechanism, and business code cannot enumerate the build environment. A Harniverse build displays `Harniverse` in the initial HTML document, the installable Web manifest, and the browser title beside a durable session title; a plain local build shows `Harniverse Local Build`. CI selects the profile inside the specific build gate rather than a workflow-wide environment, so source tests and unrelated steps never observe public client values.

Every referenced public value becomes readable artifact content, so a misnamed variable discloses information. Build choices freeze when artifacts are generated; a setting that must change after deployment needs validated runtime configuration instead. The record binds an environment to bytes and a source revision, not to a trusted builder: it proves neither a clean worktree nor a reproducible or signed build, and a fresh record can be written over modified output. The shipped sidebar wordmark and mark remain the inherited artwork until Harniverse brand assets exist.
