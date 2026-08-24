# Agent 能力

[English](capabilities.md) | 中文

[`dsh-capabilities`](../../packages/capability/capabilities/README.md) 管理 Tool、Skill、MCP-server 与 Subagent-provider adapter 共享的类型化配方目录和组装 planner。`CapabilityDescriptor` 区分可组装配方与当前实现健康状态，并携带源 Profile 默认值、不可修改定义的模型可发现成员、可选 Profile 安全配置契约、可管理性、owner、来源和硬依赖。每个 target 都投影同一份部署级配方 id 集合；target 专属的选择、成员 allowlist 与配置值描述期望组装，不会挂载该 Profile。

`CapabilityTarget` 是全局 Agent 默认值或某个 Agent Profile。省略值表示继承；全局结构化覆盖流入每个 Profile，Profile 值覆盖继承值。没有存储值时，各 Profile 保持其 YAML 原生选择、成员和配置状态。`CapabilityPlan` 是不可变、受 revision 约束的 dry-run：校验成员 id 与 owner 声明的原始字段，自动加入可组装硬依赖并记录有效操作与阻止项，且只在组装与 adapter 拓扑 revision 都未变化时可应用。

`dsh-agent-presets` 把顶层行与 group 读取为静态配方，并在下一个 standing generation 启动时把变化后的选择和配置编译为原生 `Include` patch。原生 Tool 与 Skill restriction 随后通过发现和执行强制显式成员 allowlist；由配置控制的 Web／委派成员获得完整行配置，MCP adapter 则在保留 Host 共享连接的同时隐藏整台 server 或选定工具。硬激活失败会回滚 Session 创建。运行中 Session 保持固定在原 generation；Session“能力”视图读取发布前捕获的不可变配方状态与解析成员可见性。[组装 Agent Note](../../.agents/notes/implemented/architecture/2026-08-20-scoped-capability-control-plane.md) 记录该边界。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcapabilities--capabilities"></a>

### `ctx.capabilities` — `Capabilities`

Generic capability recipe registry, composition store, planner, and Profile generation installer.

```ts cordis-catalog
/**
 * Register one native subsystem adapter on the calling plugin fiber.
 * @param create - factory receiving the registration-owned invalidation handle.
 * @returns exact disposer for the scoped adapter registration.
 */
registerAdapter(create: (control: CapabilityAdapterControl) => CapabilityAdapter): () => void

/**
 * Read the effective catalog for one global or Agent Profile target.
 * @param target - composition target whose explicit and inherited values are resolved.
 * @param view - native registry scopes and workspace used by adapters.
 * @returns deterministic capability entries and current composition/topology revisions.
 */
async snapshot(target: CapabilityTarget, view: CapabilityView = {}): Promise<CapabilityCatalogSnapshot>

/**
 * Read current explicit values for one composition target.
 * @param target - global Agent defaults or one Agent Profile.
 * @returns explicit values with the current Settings revision.
 */
composition(target: CapabilityTarget): CapabilityCompositionSnapshot

/**
 * Build the stable effective assembly identity included in a Profile generation stamp.
 * @param agentProfile - Profile whose inherited and explicit values are resolved.
 * @param descriptors - complete recipe and runtime adapter snapshot for this generation.
 * @returns sorted JSON identity of selection, visible members, and resolved configuration.
 */
compositionSignature(agentProfile: string, descriptors: readonly CapabilityDescriptor[]): string

/**
 * Apply current selection and member restrictions through every visible native adapter.
 * @param ctx - scoped standing Profile context that owns the restrictions.
 * @param entries - immutable selections resolved for this generation.
 */
mountComposition(ctx: Context, entries: readonly CapabilityCatalogEntry[]): void

/**
 * Build and retain one dry-run against exact composition and topology revisions.
 * @param target - composition target edited by the transaction.
 * @param changes - staged selection, member allowlist, and typed configuration overrides.
 * @param expectedRevision - Settings revision the editor observed.
 * @param view - native registry scopes and workspace used by adapters.
 * @returns immutable plan with operations, blockers, and resulting catalog.
 */
async plan( target: CapabilityTarget, changes: readonly CapabilityCompositionChange[], expectedRevision: number, view: CapabilityView = {}, ): Promise<CapabilityPlan>

/**
 * Commit one previously planned composition transaction.
 * @param planId - retained plan identity returned by {@link plan}.
 * @param expectedRevision - Settings revision the plan observed.
 * @returns committed explicit assembly overrides and new revision.
 */
async apply(planId: string, expectedRevision: number): Promise<CapabilityCompositionSnapshot>
```

Source: [`packages/capability/capabilities/src/index.ts:112`](../../packages/capability/capabilities/src/index.ts)

<a id="agent-presets-events"></a>

### `agent-presets/*` events

<a id="agent-presetschange--emit"></a>

#### `agent-presets/change` — emit

Agent Profile roster or composition topology changed; consumers refetch their projection. @mode emit

```ts cordis-catalog
/** Agent Profile roster or composition topology changed; consumers refetch their projection. @mode emit */
'agent-presets/change'(): void
```

Source: [`packages/preset/agent-presets/src/types.ts:6`](../../packages/preset/agent-presets/src/types.ts)

<a id="capabilities-events"></a>

### `capabilities/*` events

<a id="capabilitieschange--emit"></a>

#### `capabilities/change` — emit

Capability topology or composition changed; consumers refetch their target. @mode emit

```ts cordis-catalog
/** Capability topology or composition changed; consumers refetch their target. @mode emit */
'capabilities/change'(): void
```

Source: [`packages/capability/capabilities/src/index.ts:107`](../../packages/capability/capabilities/src/index.ts)
<!-- END GENERATED cordis-surface -->
