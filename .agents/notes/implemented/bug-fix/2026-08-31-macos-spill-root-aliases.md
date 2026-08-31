# Agent Note: macOS spill roots through stock system aliases

Status: implemented

English | [中文](2026-08-31-macos-spill-root-aliases.zh.md)

## Problem

The local spill backend rejects every symbolic-link component before creating or reading an artifact so a configured redirect cannot escape its private storage root. On macOS, Node and system APIs can spell temporary directories under `/var` or `/tmp`, while both names are stock aliases into `/private`. Treating those two system components like arbitrary configured links rejects otherwise valid private spill roots before the ownership, permission, and containment checks run.

## Decision

`dsh-spill-local` canonicalizes only a leading `/var` or `/tmp` component to `/private/var` or `/private/tmp` on macOS before its component-by-component `lstat` walk. All other platforms and path spellings use the original absolute path. Arbitrary intermediate or configured symlinks still fail, and the root plus session directory still require current-user ownership, private permissions, real directories, and a final realpath containment relationship. This is a platform accommodation inside the local Provider; the opaque [`SpillStore` contract](../architecture/2026-08-16-durable-tool-result-retention.md) does not change.

## Alternatives considered

**Resolve every configured root through `realpath`.** Rejected because it would accept arbitrary symlink redirects and remove the component-level no-follow property that protects artifact writes and reads.

**Require macOS deployments to configure `/private/...` explicitly.** Rejected because standard runtime paths can legitimately arrive with `/var` or `/tmp` spellings; callers should not need platform-specific rewriting to use the local Provider safely.

## Consequences

Private artifact roots under the standard macOS temporary-directory spellings work while custom symlinked roots remain invalid. Unusual macOS-compatible environments that assign `/var` or `/tmp` a different meaning are deliberately interpreted as the corresponding `/private` path rather than followed. Linux and Windows behavior is unchanged.
