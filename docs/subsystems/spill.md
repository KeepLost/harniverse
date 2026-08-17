# Spill Storage

English | [中文](spill.zh.md)

The spill storage seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) that persists oversized text and pages it through an opaque backend locator — is split across packages: Service Definition ([dsh-spill](../../packages/spill/spill), `ctx.spillStore`), Service Provider ([dsh-spill-local](../../packages/spill/spill-local), durable private files on the host filesystem), and Consumers ([tool-result-artifacts](../../packages/spill/tool-result-artifacts), finalized-result retention and model retrieval; and the optional [dsh-spill-policy](../../packages/spill/spill-policy)). Spill is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## The save request

`saveText` persists `content` verbatim and returns an opaque locator and the exact byte count. The request carries caller cancellation, the save-time storage namespace (`owner`), the tool and call that produced it (`source`, used for naming and inspection — not access control), and a `suggestedName` the backend may use as a naming hint (it is not a path).

```ts type-equiv
/** One request to persist text to a spill artifact. */
interface SaveTextSpill {
  /** Caller-owned cancellation for storage admission and persistence. */
  signal: AbortSignal
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}
```

## The read request and page

`readText` accepts only a locator and cursor previously produced by the same backend. The consumer passes both strings unchanged; the backend validates them and returns at most `maxChars` Unicode code points. `nextCursor` is present only when unread text remains.

```ts type-equiv
/** One backend-owned request to page a previously saved text artifact. */
interface ReadTextSpill {
  /** Caller-owned cancellation for locator validation and page retrieval. */
  signal: AbortSignal
  /** Opaque locator returned by {@link SpillRef.locator}; consumers must not parse it. */
  locator: SpillLocator
  /** Opaque continuation cursor returned by the same backend. Omit for the first page. */
  cursor?: string
  /** Maximum Unicode code points to return in this page. */
  maxChars: number
}
```

```ts type-equiv
/** One bounded page of artifact text plus an opaque cursor when unread text remains. */
interface ReadTextSpillPage {
  text: string
  nextCursor?: string
}
```

```ts type-equiv
/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
interface SpillOwner {
  sessionId: SessionId
}
```

`SpillOwner.sessionId` is the save-time storage namespace. Forked sessions inherit existing spill locators from the seeded log; those artifacts are not copied or re-owned, and spills produced after the fork use the child session id. A retention-period cleanup may expire old locators with other old session artifacts; the spill seam does not define a per-session cleanup policy.

```ts type-equiv
/**
 * Tool and call that produced one spilled artifact — recorded by the backend for a readable
 * filename and inspection. Not interpreted for access control; purely
 * descriptive.
 */
interface SpillSource {
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: CallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
}
```

## The result

```ts type-equiv
/** A saved spill artifact: its opaque locator and exact byte length. */
interface SpillRef {
  locator: SpillLocator
  bytes: number
}
```

`SpillLocator` is a [branded](core.md#branded-ids) model-facing handle returned by the backend. The local backend returns a versioned opaque token rather than a host path; another backend may use a URI or key. Consumers never parse it and own all model-facing retrieval guidance.

```ts type-equiv
/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render but do not parse it.
 */
type SpillLocator = Branded<'SpillLocator'>
```

## The service

`SpillStore` (`ctx.spillStore`, defined in [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)) owns two abstract operations: `saveText(input) → Promise<SpillRef>` and bounded `readText(input) → Promise<ReadTextSpillPage>`. Both follow caller cancellation and reject storage, locator, cursor, or integrity failures. The seam owns storage and paging only, not retention policy, tool-result replacement, or search.

The local backend ([dsh-spill-local](../../packages/spill/spill-local)) writes under the durable Harniverse home by default. Its root and session directory must be real, private, current-user-owned directories; random exclusive 0600 leaves reject planted targets. Locators contain only a version, session hash, and safe leaf name, while backend cursors are UTF-8 byte offsets. `dsh-tool-result-artifacts` saves a complete finalized oversized result before emitting a bounded preview and structured locator, then pages it through `artifact_read`. The disabled-by-default policy Consumer remains an explicit best-effort early spill option.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspillstore--spillstore-abstract-seam"></a>

### `ctx.spillStore` — `SpillStore` (abstract seam)

Abstract spill storage service. Subclass, implement saveText, and load the subclass as a plugin — it registers as `ctx.spillStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- saveText persists the FULL `content` verbatim and returns an opaque locator and exact byte length.
- Storage is scoped by the request's SaveTextSpill.owner session; the backend chooses a private (not world-readable) location and a collision-free name derived from — never equal to — the caller's `suggestedName`.
- `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable); the caller decides how to degrade (the spill policy treats a rejection as best-effort and keeps the inline result).
- Both operations observe the request's caller-owned cancellation signal and settle promptly after cancellation.

```ts cordis-catalog
/**
 * Persist `input.content` to a session-scoped spill artifact.
 * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
 * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
 */
abstract saveText(input: SaveTextSpill): Promise<SpillRef>

/**
 * Read one bounded page from a locator produced by this backend.
 * @param input - opaque locator, optional backend cursor, and page character limit.
 * @returns bounded text and an opaque continuation cursor when unread text remains.
 */
abstract readText(input: ReadTextSpill): Promise<ReadTextSpillPage>
```

Source: [`packages/spill/spill/src/index.ts:53`](../../packages/spill/spill/src/index.ts)
<!-- END GENERATED cordis-surface -->
