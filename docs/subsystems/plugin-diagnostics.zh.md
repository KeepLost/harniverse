# 插件诊断

[English](plugin-diagnostics.md) | 中文

[`dsh-plugin-diagnostics`](../../packages/runtime-diagnostics/plugin-diagnostics/README.md) 拥有 `ctx.pluginDiagnostics`，即用于只读检查的 effect 作用域注册表。检查包含稳定 id 和说明，并返回当前发现项。诊断对注册项制作快照，依次执行检查，按严重程度和标识排序发现项；贡献抛出异常或返回无效结果时，诊断会生成通用 `diagnostic-check/check-failed` 发现项，并仅把原始异常写入 Host 日志。

`PluginDiagnosticFinding` 包含 `checkId`、稳定 `code`、`severity`（`info`、`warning` 或 `error`）、`domain`、`message`，以及可选的 `path` 和 `fixHint`。`PluginDiagnosticReport` 包含 `observedAt`、`checksRun` 和已排序的发现项。路径是诊断地址而非修改标识，修复提示是文本而非可执行修复描述。

[`dsh-plugin-diagnostics-cordis`](../../packages/runtime-diagnostics/plugin-diagnostics-cordis/README.md) 贡献 Host Loader、standing preset 和动态 package 检查。这些检查仅在诊断运行时读取各 owner 的活动清单。它们省略异常值、stack trace、源码、配置和凭据，也不推断活动根 fiber 就是健康。现有 Host plugin-inventory Remote 向 `harniverse.observe` 调用方公开报告，Web 设置则在没有修改控件的情况下渲染报告。[只读诊断 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-read-only-plugin-diagnostics.md) 负责此安全决策。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplugindiagnostics--plugindiagnostics"></a>

### `ctx.pluginDiagnostics` — `PluginDiagnostics`

Registry and coordinator for read-only plugin diagnostics.

```ts cordis-catalog
/**
 * Register one read-only check on the calling plugin fiber.
 * @param check - stable identity, description, and observation callback.
 * @returns the exact disposer that removes the contribution.
 */
register(check: PluginDiagnosticCheck): () => void

/**
 * Run a snapshot of registered checks sequentially and contain check failures.
 * No repair callback or mutation capability exists on this service.
 * @param signal - optional cancellation checked before each contribution.
 * @returns sorted point-in-time findings.
 */
async diagnose(signal?: AbortSignal): Promise<PluginDiagnosticReport>
```

Source: [`packages/runtime-diagnostics/plugin-diagnostics/src/index.ts:74`](../../packages/runtime-diagnostics/plugin-diagnostics/src/index.ts)
<!-- END GENERATED cordis-surface -->
