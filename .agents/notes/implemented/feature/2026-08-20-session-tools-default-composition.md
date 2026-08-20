# Agent Note: Session tools ship in the default composition

Status: implemented

English | [中文](2026-08-20-session-tools-default-composition.zh.md)

## Problem

The cross-session query and delivery packages were present in the workspace and in the ACP test overlay, but the shipped Web Agent Profiles did not mount their model Consumers. The shipped SQLite provider also disabled full-text search, so a visible `session_search` tool would still have failed at execution.

## Decision

The shared base composition mounts `session-delivery-local`, `tool-session-query`, and `tool-session-delivery`. The Web bundle disables only the global Consumer rows, and every shipped Agent Profile mounts both Consumers in its own scope, including `minimal`. The local delivery Provider remains host-scoped because it resolves process-wide Agents and Sessions.

The shipped SQLite provider uses `openAt: first-search` with its existing in-memory derived index. Exact reads remain available before the first search, while the first content search opens and reconciles the index without importing SQLite during startup.

## Alternatives considered

- **Keep the Consumers in the ACP-only overlay** — rejected because the shipped Web and headless Agents could not use or exercise the capability.
- **Mount the Consumers globally in Web** — rejected because the Web tool layer is intentionally empty and Profile identity owns model-facing tools.
- **Leave `openAt: never`** — rejected because the default search schemas would advertise an operation that always returns `SESSION_QUERY_SEARCH_DISABLED`.

## Consequences

- Standard, Code, Cordis, and Minimal shipped Profiles expose the seven query/read tools plus `session_send_message` and `session_unload`.
- TUI and headless compositions receive the same tools from the shared base rows.
- Search remains lazy at startup and uses a disposable in-memory index; deployments that need a durable derived index can override the existing path.
- The capability exposes deployment-visible session discovery and process-local delivery, so the existing opaque-id and ordinary-session authorization rules remain in force.

## Verification

- The real Web Agent Profile composition asserts the standard and minimal tool rosters.
- The base bundle test asserts the provider, Consumers, and lazy SQLite configuration.
- The built Web startup compatibility test asserts `openAt: first-search` on both base and Web rows.
