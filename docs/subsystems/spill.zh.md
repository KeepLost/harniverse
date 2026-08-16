# spill 存储

[English](spill.md) | 中文

spill 存储 seam 是一项[能力 seam](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md)，它持久保存超大文本，并通过不透明的后端 locator 分页读取。该能力拆分到多个包：Service Definition（[dsh-spill](../../packages/spill/spill)，`ctx.spillStore`）、Service Provider（[dsh-spill-local](../../packages/spill/spill-local)，宿主文件系统中的持久私有文件），以及 Consumer（[dsh-tools](../../packages/core/tools) 的最终结果保留、面向模型检索的 [tool-artifact-read](../../packages/spill/tool-artifact-read)，和可选的 [dsh-spill-policy](../../packages/spill/spill-policy)）。spill 是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇记录在此处，而不在 [core.md](core.md) 中。

源码：[`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## 保存请求

`saveText` 原样持久保存 `content`，并返回不透明 locator、后端提供的检索提示和准确字节数。请求携带调用方取消、保存时存储命名空间（`owner`）、生成内容的工具和调用（`source`，用于命名和检查，而非访问控制），以及后端可用作命名提示的 `suggestedName`（它不是路径）。

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

## 读取请求与分页

`readText` 只接受同一后端先前生成的 locator 和 cursor。消费方原样传递两个字符串；后端负责校验，并返回最多 `maxChars` 个 Unicode 码点。只有仍有未读文本时才包含 `nextCursor`。

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

`SpillOwner.sessionId` 是保存时的存储命名空间。fork 后的会话会从种子日志继承已有的 spill 定位符；这些产物不会被复制或重新取得所有权，fork 后产生的 spill 则使用子会话 id。保留期清理可以连同其他旧会话产物一起使旧定位符失效；spill seam 不定义逐会话的清理策略。

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

## 结果

```ts type-equiv
/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` 是后端返回的[品牌化](core.md#branded-ids)面向模型句柄。本地后端返回带版本的不透明 token，而不是宿主路径；其他后端可以使用 URI 或键。消费方绝不解析它，而是渲染后端的 `retrievalHint`。

```ts type-equiv
/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
type SpillLocator = Branded<'SpillLocator'>
```

## 服务

`SpillStore`（`ctx.spillStore`，定义于 [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)）拥有两个抽象操作：`saveText(input) → Promise<SpillRef>` 和有界的 `readText(input) → Promise<ReadTextSpillPage>`。两者都会遵循调用方取消，并拒绝存储、locator、cursor 或完整性故障。该 seam 只负责存储和分页，不负责保留策略、工具结果替换或搜索。

本地后端（[dsh-spill-local](../../packages/spill/spill-local)）默认写入持久 Harniverse home。根目录与会话目录必须是真实、私有且归当前用户所有的目录；随机且排他的 0600 叶子文件会拒绝预先植入的目标。locator 只包含版本、会话 hash 和安全叶子名，后端 cursor 则是 UTF-8 字节偏移。ToolRuntime 会先保存完整的最终化超大结果，再发出有界预览和结构化 locator；`artifact_read` 对它分页。默认禁用的策略消费方仍可作为显式的尽力而为早期 spill 选项。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspillstore--spillstore-abstract-seam"></a>

### `ctx.spillStore` — `SpillStore` (abstract seam)

Abstract spill storage service. Subclass, implement saveText, and load the subclass as a plugin — it registers as `ctx.spillStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- saveText persists the FULL `content` verbatim and returns an opaque locator, exact byte length, and model-facing retrieval guidance.
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

Source: [`packages/spill/spill/src/index.ts:54`](../../packages/spill/spill/src/index.ts)
<!-- END GENERATED cordis-surface -->
