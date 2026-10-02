# Agent Note: Lossless projection checkpoint JSON

Status: implemented

English | [中文](2026-09-19-lossless-projection-checkpoint-json.zh.md)

## Problem

Projection checkpoints can contain opaque extension data and message metadata. A JSON key named `__proto__` is ordinary recorded data. The Zod JSON parser drops that own key while rebuilding objects, so reopening a valid checkpoint can yield different projection state from replaying the Session log.

## Decision

The checkpoint value schema uses the existing `isJsonValue` predicate from `dsh-session`. It enforces the same lossless JSON rules as the checkpoint writer's `snapshotJsonValue` without rebuilding valid objects. Validation still rejects non-JSON and lossy values. Storage-domain table values are immutable borrowed records; the validator does not supply a defensive-copy guarantee.

Ported from official DSH `df0145271d` during the 2026-10-02 wave-4 absorption.

## Alternatives considered

- **Keep `z.json()`.** Its object reconstruction removes valid own keys, so a successful validation can still change the checkpoint value.
- **Validate and clone with `snapshotJsonValue`.** This preserves keys but copies already immutable stored values. The read-only predicate matches the storage-domain borrowed-value contract.

## Consequences

Every valid own key survives domain reopen, including nested `__proto__` and `constructor` properties. The domain version remains unchanged because the stored JSON representation is unchanged; this corrects its reader. Regression coverage validates a record whose state carries own prototype-named keys through the actual schema, and retains rejection of values that cannot survive a lossless JSON round trip. Session format versions and historical generations do not change.
