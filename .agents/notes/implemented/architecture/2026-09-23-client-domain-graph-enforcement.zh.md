# Agent Note: 客户端领域门此前漏报，随后一次清扫把共享契约搬进了 contract/

Status: implemented

[English](2026-09-23-client-domain-graph-enforcement.md) | 中文

## Problem

`scripts/verify-client-domain-graph.ts` 执行的是 ui-conversation 时代的分层规则（包内 `src/client/` 划分为 `contract/` 与互不跨域的领域目录，仅 `apply`／`index` 负责组装），但脚本自身有三个缺陷：爬出 `src/client/` 的相对 specifier 被当作包内导入而未解析跳过；内联 `import('…')` 类型引用因只匹配 `from '…'` 子句而不可见；`src/client/` 下任意子目录都被当作领域，双文件组件目录被报成跨域违规。修复门之后——specifier 解析带逃逸处理、三种 specifier 模式按匹配偏移去重、非 contract 目录数 `< 2` 时提前退出、报告附带 1 起始行号——它在 `runtime` 与 `ui-conversation` 里找出了 24 条此前被漏报或误报的真实违规。而该门此前只在本地 `check:all` 模式下运行，没有任何 CI lane 执行它，等于处处未强制。

## Decision

修门、修完 24 条违规、把门接入 CI。`runtime` 侧：对外会话状态模型（列表行、列表 store 形状、子代理目录快照、会话绑定句柄、provide 描述符）移入新的 `contract/session-state.ts`；对话读模型（`conversation.ts`、`pending.ts`、`context-provenance.ts`——按其自身头注释，即逻辑层喂给 UI 的唯一数据形状）移入 `contract/` 成为 `conversation-snapshot.ts`；`WorkspaceListState`／`WorkspaceListPhase` 移入 `contract/workspaces.ts`；单文件的 `agents/` 目录并入顶层 `agent-scope.ts`；`notifier.ts` 移到两个领域共享的顶层。`ui-conversation` 侧：输入契约（`input/contract.ts` → `contract/input.ts`）、组合器块模型（`input/blocks.ts` → `contract/input-blocks.ts`）、轮次度量（`chat/turn-metrics.ts` → `contract/turn-metrics.ts`）、StatsLine 纯辅助函数（抽取为 `contract/chat-stats.ts`，组件留在 `chat/`）与 `queueReadFaceOf`（进入 `contract/queue.ts`）都搬入契约层，唯一消费者的 `tool-node-reader.ts` 与 `decorations.ts` 则移到消费者所在的 `skeleton/`。该门现在是两条 CI 静态 lane 中紧邻 `verify-module-graph` 的 `client-domain-graph` 步骤，并有 run-gates 成员性测试把它钉在 `ci-primary`、`ci-static` 与 `check-all`。

## Alternatives considered

从 `contract/` 做 re-export 垫片当即被否：垫片自身 import `../domain/…` 就是一条 contract→域边，门会转而标记垫片。工作台 store 内保留按 Workspace 的 `section` 状态（与面板搬迁笔记中改为 layout store 的决定相对）与本清扫无关。让单目录包继续受兄弟域规则约束的方案也被否：只有一个非 contract 目录的包没有兄弟可跨，且 `packages/client/AGENTS.md` 把规则范围限定在「未来可能拆分为独立包」之处。

## Consequences

客户端包的每条跨域边如今单向（领域 → 契约），门报告零违规，并且 CI 在每个 PR 上强制执行。生成的客户端 slot 目录已按 `WorkspaceListState` 的新位置重新生成。包的公共 API 不变——barrel 从新位置再导出同名符号。

## Testing

`./node_modules/.bin/tsx scripts/verify-client-domain-graph.ts`（24 条违规 → 干净）；`pnpm run typecheck`；`NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/vitest run packages/client/runtime/tests packages/client/ui-conversation/tests --maxWorkers=1 --no-file-parallelism`（865 个测试）加两包的 per-file 覆盖门；`NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/vitest run scripts/run-gates.spec.ts --maxWorkers=1 --no-file-parallelism`（44 个测试含三条新成员性断言）。
