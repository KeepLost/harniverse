# Agent Note: 已打开的子代理目录在瞬态证据跌零期间由用户持有

Status: implemented

[English](2026-09-18-open-catalog-evidence-hysteresis.md) | 中文

- 日期：2026-09-18
- 范围：`@deepseek-ai/dsh-client-ui-subagent`（目录动作生命周期）
- PR：pending（本笔记随修复一同提交）

## 问题

`cold-resumes the original subagent while its ordinary fork stays active` 这一 e2e 在发布分支的 Windows coverage 与 web 分片上失败：目录触发按钮的点击始终无法命中——Playwright 报告按钮 `not stable` 随后 `detached from the DOM`，持续满 30 秒可交互窗口；改为轮询重试的点击也始终等不到目录树打开。

`SubagentCatalogAction` 以子代理证据门控自身渲染：目录条目、摘要索引出的后代、或加载错误。fork 出的会话流式输出期间，会话列表 store 在每次提交时重发布 `byId` 与 `subagentsByParent`，而重水合或刷新提交可能瞬间既不含后代摘要、也不含目录行。在这种提交上 `visible` 跌为 false，组件返回 `null`——在交互中途卸载触发按钮；旧的单侧关闭 effect（`if (visible || !open) return; setOpen(false)`）又在同一次跌零上强制关闭已打开的菜单。流式持续期间跌零反复出现，任何点击都无法打开并保持目录。

## 决策

已打开的目录由用户持有。组件在 open 状态下无视瞬态证据继续渲染（`if (!visible && !open) return null`），菜单子树额外以 `presentedCatalog !== undefined` 门控，跌零期间不会让 `CatalogRows` 拿不到快照。关闭 effect 仅在权威目录 **与摘要一致地** 落定为空（`state === 'ready'`、零条目、零索引后代）时触发——仅 stale-empty 的目录保持打开，与既有的摘要兜底引导行为一致。

关闭态触发按钮的可见性不变：无任何其他子代理证据的裸 loading 目录依旧不会在无子会话上闪现。

## Consequences

- 流式或重水合期间点击目录可靠：触发按钮保持挂载，打开的菜单在瞬态跌零的 store 提交间存活。
- 子代理确实全部消失的菜单，在目录刷新落定为空且摘要一致时自动关闭；observed 目录的释放与之前完全一致。
- 跌零隐藏菜单主体（触发按钮仍在）期间，键盘树项缺席；焦点本就在触发按钮上，它始终可交互。
- e2e 保留轮询式 `openSubagentCatalog` helper 作为对纯视觉抖动的纵深防御，但正确性不再依赖它。

## Alternatives considered

- **一旦挂载永不隐藏（全迟滞）：** 否决——真正失去全部子代理的会话将永远留下一个计数为零的死按钮；一致性检查为删除给出了确定性的落定点。
- **修 store 使其永不发布丢子快照：** 更深且风险更高；对象层在冷恢复期间重建基线是合法行为，表现层健壮性不应要求 store 的事务性保证。
- **仅测试侧重试（poll-click 已合入）：** 不充分——CI 运行显示 30 秒连续 detach，菜单本身每次提交都被强制关闭时，任何点击策略都无解。
