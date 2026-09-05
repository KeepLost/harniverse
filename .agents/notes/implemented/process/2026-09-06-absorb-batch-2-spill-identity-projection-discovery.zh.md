# Agent Note: 吸收批次 2——spill 启动清扫、tool-call 身份、projection 变更流、Anthropic 原生发现

Status: implemented

[English](2026-09-06-absorb-batch-2-spill-identity-projection-discovery.md) | 中文

## 问题

官方增量中又有四个 Absorb-soon 项。本地 spill 存储完全没有保留策略——spill 根跨重启无限增长。DeepSeek 适配器的流式翻译在续传 delta 把字段重发为空或 `null`（若干 OpenAI 兼容网关的形状）时覆盖已确立的 tool-call id/name，破坏会话可读性。会话投影 drive 在每次状态引用变化时都通知，纯内部状态突变被扇出为虚假的 `session/projection` push 发给每个订阅客户端。模型发现只探询 OpenAI 兼容形状，对 provider profile schema 已允许声明的 Anthropic Messages 端点报错。

## 决策

按契约级移植。spill 存储获得官方一次性启动清扫：`cleanupPeriodDays`（默认 30，`0` 禁用，整数 schema），仅当 `mtime` 严格早于截止线且位于精确形状 `session-[0-9a-f]{12}` 会话目录内的普通文件才删除（符号链接与特殊条目跳过，根目录永不删除），清空的会话目录被修剪，每项失败 best-effort 仅 warn（ENOENT/ENOTEMPTY 竞态静默），清扫由 fiber 持有、不延迟激活、dispose 时等待，写入侧在清扫竞态修剪目录后重试独占打开。适配器获得官方身份规则——`id` 与 `name` 是身份而非累积：续传 delta 重发为空或 `null` 意为"无更新"，wire 类型放宽为 `string | null`，并行调用无论 delta 顺序都保持各自身份。投影 drive 现在以 `Object.is` 比较的原始 `view` 结果门控变更流，经两槽观测视图缓冲：状态可缓冲工作字段而不发布，未观测变化至多桥接一代，对象值视图须复用引用保持静默。发现层原生探询 Anthropic Messages——`GET {root}/v1/models?limit=1000` 带 `x-api-key` 与 `anthropic-version: 2023-06-01`，只读一页，增强 `models` 映射回退解析——但仅在声明指名协议时（草稿 `api`，或存储 profile 的 `api` 作为新增回退）；未声明端点恰好收到一次 OpenAI 形探测、与之前逐字节一致，按所有者的显式声明决策。Profile 头在解析时经 Fetch 校验，Harness 归因头保留名必胜。

## 考虑过的替代方案

**同一官方 commit 的可重试 `MALFORMED_TOOL_CALL` 完成守卫。** 刻意否决：上游次日用 `b03261caad` 撤销了那一半——它会覆盖提供方 finish reason、把安全的 `max-tokens` 截断变成最多五次重试；参考 pin 的最终语义只有身份守卫，落地即此。

**定时或退出时清扫。** 与官方一致否决：循环定时器让清扫反复与活跃会话竞速无增益，退出时清理天然不可靠；一次性启动清扫与恢复/分叉会话的保留语义精确匹配。

**projection-cache 跨版本读兼容（#7 后半）。** 有证据的 NO-OP：我方缓存只有单一版本代际、无 lineage 字段、无按记录布局，仓库 pre-release 立场明确拒绝为旧格式建兼容层。

## 结果

spill 根不再无限增长；网关重发身份不再破坏 tool-call 块；Web 客户端不再收到不改变视图的状态变化 push；被声明的 Anthropic 形端点可被发现——且仅在被声明时。兼容性：`cleanupPeriodDays` 默认对新文件保持现行保留行为，未声明端点的发现流量与之前逐字节一致，投影契约只对纯内部状态收紧（依赖引用变化 push 发布未变视图的域现在正确保持静默）。证据：每项 RED 先行回归（spill 清扫 24 例族、身份守卫 4 例含修复前复现的身份清空失败、视图门控发布测试含双发失败复现、Anthropic 发现 7 例含恰好一次探测钉扎）；聚焦套件绿（spill-local 70、llm-deepseek 325、llm 214、session-projection 闭包 61、llm-pi-ai 234）；`doc-sync` 29/29、`typecheck`/`oxlint`/`knip` 全净；触碰源文件 per-file 覆盖干净。
