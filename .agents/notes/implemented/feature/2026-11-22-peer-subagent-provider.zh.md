# Agent Note：Peer subagent provider —— 配对信道作为进程外后端

Status: implemented

[English](2026-11-22-peer-subagent-provider.md) | 中文

- 日期：2026-11-22
- 里程碑：peer 配对 roadmap M8（狭义立项）
- 包：`packages/subagent/subagent-peer`（新增）、`packages/peer/peer-client`（共享助手）、`packages/peer/tool-peer`（重构为共享助手）
- 评审工件：PR #331

## 问题

与另一个 Harniverse 实例配对的部署只能经专用 `peer` 工具把该实例暴露给自己的模型：普通 `subagent` 缝——统一工具措辞、`subagent/start|end` 可观测性、fail-loud 能力门控——没有能在配对实例上运行子 agent 的传输层。

## 决策

配对信道成为一条 subagent 传输：`dsh-subagent-peer` 在 `ctx.subagents` 上注册 `peer` 提供方，每次委派运行就是单个配置配对实例（`peerTarget`：精确实例 id 或显示名，逐运行解析）上的一个全新会话。定时委派撤案确立"组合覆盖门"之后，owner 批准了狭义立项（D20）；下列每项功能决策都遵循"provider 是 peer 缝的消费方，绝不是它的扩展"。

## 为什么是一次性，以及为什么这是诚实的

seam 的续聊路径物化的是本地子会话——continuation manager 拥有 Agent 创建与轮次，`prepareContinuable` 只贡献种子数据——远端部署根本无法承载续聊子 agent。我们没有重设计 continuation manager，而是镜像既有的进程外形态（ACP/Codex/Claude Code）：一次性 `start()`、`NO_START_CAPABILITIES`，续聊请求由服务自身显式拒绝（"no prepareContinuable capability"）。工具行以 `backgroundMode: 'one-shot'` 挂载（D21；seam 的 fail-loud 规则覆盖每个能力请求）。

唯一的 `peer/delegate` RPC 同时提交 prompt 并等待首次落定，因此 `start()` 以一个已是终态的结果完成：发布即 wire 读回，`dispose()` 没有本地工作，只有传输失败或发布前取消会让 `start` 拒绝（D22/D24）。run id 就是 peer 会话 id——在配对内唯一、可经 `peer` 工具续聊——这是 ACP 进程内作用域 id 做不到的一件事（D23 的可实现形态：续聊在 peer 工具上，不在 subagent 缝上）。

## 设计时记录的能力边界

- D21——无父侧强制能力：远端自组组合；服务在任何 wire 调用前拒绝 `outputSchema`/`maxDepth`/`toolFilter`/`persona` 请求。
- D22——owner 配置目标：`peerTarget` 位于 provider 配置（部署组合），从不出现在面向模型的工具 schema 里；模型只选 prompt。
- D24——取消仅本地放弃：发布前中止让 `start` 拒绝，被放弃的远端回合运行到完成并消耗自己的预算；记为已知限制，无远端中止 wire。
- D25——无工件桥接：subagent 工具的 prompt 仅文本（非文本块在拨号前拒绝）；文件继续经 `peer` 工具的上传/下载设施流动。最初草拟的"prompt 文件走 uploads"在该工具 schema 里没有入口。
- D26——预算归因不变：委派回合消耗配对自身的治理（surface 门控、回合预算、字节预算），与手动 `peer` 调用完全一致；无新记账面。

## 停止原因映射

peer `endReason` 就是 harness 的回合结束词汇，共享原因直通（`completed`/`refusal`/`max-tokens`/`aborted`），未知原因摊平为 `error` 并以原始值作诊断，预算点仍在 `running` 的回合以 `error` 落定并附命名 peer 会话的续聊诊断。落定但缺 endReason 的回合计为 completed。

## 抽取的共享助手

`selectPeerTarget`（带活跃目录的实例 id/显示名解析）与 `peerFailureMessage`（封闭原因措辞）移入 `dsh-peer-client`，`tool-peer` 与新 provider 共同消费——选择器语义与诊断和原内联副本逐字节一致。

## 同缝基线修复

ACP loader e2e（`subagent-acp/tests/loader-composition.e2e.ts`）在 HEAD 上是红的且不被任何 CI gate 看守：续聊迁移把工具普通路径变成 `invoke()`（所有一次性-only 提供方都会被拒），且夹具断言早于 legacy 一次性渲染。夹具现在钉定 `backgroundMode: 'one-shot'` 并断言当前渲染（Final output 承载 cwd 回显），让该套件在本地回到绿。

## 测试与验证

- 单元（`tests/subagent-peer.spec.ts`，15 例）：prompt 准入（仅文本/空/超长在拨号前拒绝）、落定映射（含预算点 running 与未知原因诊断）、传输失败以 peer 原因摊平、发布前中止与已中止拒绝、目标缺失/歧义目录、服务级能力与续聊拒绝、预算收敛、空 `peerTarget` 装载失败。包 src 语句/分支/函数 100%（不可能的非 PeerError 传输臂带理由忽略，镜像 `out-of-process.ts`）。
- REAL 组合（`tests/loader-composition.e2e.ts`）：以测试专用 `cordis.yml` 经 Loader 启动 headless 应用；脚本化父模型经普通 `subagent` 工具向脚本化配对目标（真实 HTTP）委派一次，会话日志断言 legacy 一次性渲染发布 peer 会话 id 并以 Final output 承载落定回复。纯 mock 组合、keyless 层（peer 信道自身的跨实例 e2e 在 peer 套件里）。
- 助手抽取后 `dsh-peer-client`/`tool-peer` 套件保持绿（peer 组 205 例）。

## 备选方案

- 重设计 continuation manager 以承载远端续聊子 agent：狭义章程下拒绝——manager 按契约物化本地子会话，改变该所有权模型是缝重设计，不是一个 provider。
- 对回复文本做本地 `outputSchema` 事后校验：拒绝——静默降级味道；schema enforcement 属于父侧无法控制的子侧。
- 在 `subagent` 之外加一个专用 `peer-subagent` 模型工具：拒绝——重复缝工具与措辞的第二个面向模型的委派入口。
- 定时委派式的组合捷径：已在组合覆盖门下撤销；本 note 的 provider 只添加 `peer` 工具结构性给不了的东西（统一寻址、标准 run 事件、以 peer 会话 id 作为 run id 的持久身份）。

## 后果

- 部署现在可以经普通 `subagent` 工具提供一个配对实例，带标准 `subagent/start|end` 可观测性（`local: false`），而续聊与文件仍以 `peer` 工具为一等公民——两个工具、一条缝、无重复编排。
- 狭义章程明确不做：续聊远端子 agent（需要 continuation manager 重设计）、远端取消（需要 wire 决策）、工件桥接（需要入口）。每一项都以 Known Limitation 记录并附升级触发条件。
- 文档/名单中的提供方现为 `spawn`/`fork`/`acp`/`peer`/`codex`/`claude-code`/`dsh-sdk`。
