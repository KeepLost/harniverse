# Agent Note: Shared workspace domain version

Status: implemented

English | [中文](2026-08-19-shared-workspace-domain-version.zh.md)

## Problem

Official DSH and Harniverse use the same `$DSH_HOME` storage root and the same `workspace` unit name. The official workspace domain is version 2, while a Harniverse-only Session deletion journal temporarily raised that unit to version 3. The storage backends reject a stamped unit version that differs from the descriptor, so starting Harniverse after official DSH failed before the Workspace registry became available.

## Decision

The shared `workspace` domain remains version 2 and contains only data understood by official DSH. Harniverse stores `pendingSessionDeletionIds` in a separate `workspace_deletion` domain at version 1. `WorkspaceRegistry` opens and closes both domains as one service and keeps the public deletion-recovery methods unchanged.

The domain descriptor supports an explicit `migrateFrom` list. JSON and SQLite backends rewrite a listed older unit stamp to the current stamp while preserving its opaque records. The workspace spec accepts version 3 as a one-time source version; startup transfers its legacy deletion marker to `workspace_deletion` and rewrites the shared workspace global without that field. Unsupported versions still fail loudly.

## Alternatives considered

**Keep version 3 and change only the Harniverse schema.** The official DSH process would continue to reject the shared `workspace` unit, so alternating the two applications would remain impossible.

**Downgrade the workspace descriptor to version 2 while retaining the deletion field there.** Official DSH could parse the field as unknown, but any official workspace write could erase a Harniverse recovery marker. The fork-specific journal must have its own durable owner.

**Give Harniverse a separate storage root.** That would avoid the version collision but split workspace metadata from the shared session root and strand existing records under the old root. Sharing the official workspace unit is the intended behavior.

**Silently accept every version.** A version mismatch can represent an incompatible record layout. Only the owning spec may name a source version, and the backend rejects every other stamp.

## Consequences

Official DSH and Harniverse can open and mutate the shared version 2 workspace unit in either order. Harniverse deletion recovery is isolated in `workspace_deletion`, so official DSH cannot overwrite it. Existing Harniverse version 3 workspace media is rewritten on the first Harniverse start and its legacy deletion marker is preserved. A future incompatible workspace change must use a new explicit migration or a new domain version; it cannot widen `migrateFrom` casually.
