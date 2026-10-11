# Agent Note: 结构化模型策略设置与新会话方案 chip

Status: implemented

[English](2026-10-11-model-policy-ux.md) | 中文

## 问题

模型策略设置页此前是叠在 `model-profiles` 与 `model-routes` 两个 settings section 之上的两个裸 JSON 文本框。用户必须手工拼写 provider 路由 id、模型 id、推理强度 id 与 route id；保存时只校验格式，错误的默认 Profile 或悬空的 Route 引用会在之后以 `internal` 错误打断每一次新建会话。composer 的模型菜单显示 route id 而非名称；Profile 的模型条目未写推理强度时，过滤目录仍提供该模型，`session.selectModel` 却会拒绝（host 先补默认强度，而守卫按精确强度比较）；会话开始前也没有选择 Profile 的途径。

## 决策

**单一设置文档。** 两个 section 合并为单一的 `model-policy` namespace，同时持有 `defaultProfile`、`profiles` 与 `routes`，因此所有交叉引用在保存时一并校验、一并落盘：Profile 不得引用未知 Route，默认目标必须落在自身允许范围内（模型或 Route），默认 Profile 必须存在，名称与 provider/model/effort 字符串不得为空，保留 id `unrestricted` 不可重定义。同一判据也作用于构造函数中的组合入口（错误组合的部署在最早可判定点失败）以及经 settings `validate` 钩子的每次存储写入。`remote-runtime` 同步与 apiproxy 暴露白名单已切换到单一 namespace。合并前的 namespace 在本部署中没有已存数据，无需迁移；无效的已存文档现在按设计在启动时让 section 注册失败。

**强度条目未指名即为通配。** `allowsTarget` 现允许 Profile 中未写强度的模型条目匹配该模型的任意强度，与 `allowsConcrete` 及目录过滤一致；写明强度的条目仍只允许该强度。

**结构化编辑器取代 JSON 文本框。** 策略页（导航更名为 模型方案/Model Profiles，复用 Models 图标）在一个 `ModelPolicyStore` 之上渲染两组卡片列表：备用链是从实时 `llm.models` 目录挑选的有序目标行（可按目标限制推理强度，支持上下移动，目录外条目带徽标且仍可编辑）；方案是逐模型允许项（可选强度限制）、备用链勾选框、单一默认目标，以及列表头的默认方案选择器。一次只展开一张编辑卡；每次保存都以打开时的 revision 整体替换用户文档，并发修改以 `settings-conflict` 呈现。被任何方案引用的备用链拒绝删除，基础层条目呈现为锁定。编辑方案会把同一模型的重复允许项归一为单条。页面不再保留 JSON 逃生门——所有字段都能在结构化编辑器中表达。

**无会话名册与 hero chip。** 新增 `llm.modelProfiles` RPC（能力 `harniverse.observe`）提供 Profile 描述符与默认 id。`conversation.hero.modelProfile`——ui-conversation 新的 root 级 slot，由 ui-model-selection 占位——在新会话屏幕上渲染于 Agent 预设 chip 旁，仅剩 `unrestricted` 时隐藏。与预设 chip 不同，选择会经 `session.selectModelProfile` 立即作用于当前空白会话（模型方案按会话可变）；没有当前会话时先暂存并调用 `workspaces.startSession(undefined, undefined, modelProfile)`，由 runtime 经 `connectWorkspace` 传入 `session.create` 既有的 `modelProfile` 字段，reconciliation 再切换复用到的、以其他方案创建的空白会话。composer 的 Route 行改显名称，两个模型表面统一将 Profile/Route 称为 模型方案/备用链。

## 备选方案

- **保留双 namespace 并交叉校验。** 先注册 Route 再注册 Profile 可让 Profile 校验读到 Route 源，但 Route 侧删除仍可能悬空 Profile 引用、只在下次启动时暴露，且两个 section 的写入无法原子。预发布阶段（无已存数据、无兼容承诺）使单文档合并成为正确基础。
- **仅做创建期方案选择。** 把暂存方案穿进每条会话创建流程可以完全复刻 Agent 预设 chip，但每次改主意都会新建空白会话，并让惰性创建流程与首条消息竞态。对当前空白会话即时应用，同时保留线上既有的 `modelProfile` 创建字段给程序化调用方，避免了两者。
- **在"高级"折叠区保留 JSON 逃生门。** 文档的每个字段都能在结构化编辑器中表达，第二条编辑路径只会分叉校验与文案；原始文档仍可在 `settings.yaml` 中阅读。

## 影响与后果

- 经原始 settings API 写入策略文档的调用方现在与 UI 面临同一校验；先删 Route 再在同一次调用中改 Profiles 的 remote-runtime 快照会被拒绝，需按 Profiles 在前的顺序落盘。
- 方案编辑器的保存会把同一模型的重复允许项归一，并把基础层条目物化到用户层（设置合并中数组整体替换）；携带基础层策略的部署应把首次用户编辑视为复制点。
- hero chip 在当前会话变化时经 `session.models` 读取其方案（摘要不含该字段）；若日后摘要携带，chip 的额外读取可移除。

## 验证

- `packages/core/model-policy`：37 个测试，覆盖每条非法不变量的保存时拒绝、通配强度回归、组合入口加载时拒绝；行/分支覆盖 100%。
- `packages/client/ui-settings-models`：策略页、store 与两个编辑器由 20 余个组件测试覆盖（创建、重排、目录外条目、冲突、principal 切换、删除锁定）；整包行/分支覆盖 100%。
- `packages/client/ui-model-selection`：hero seat 控制器与 chip 由 23 个测试覆盖（暂存、即时应用、reconcile、被取代的响应、RPC 缺失）；新文件行/分支覆盖 100%。
- `apps/web/tests/models-policy.e2e.ts`：无密钥浏览器场景——注册免引用提供方、从实时目录构建备用链、创建方案、记录默认选择、端到端演练 hero chip，附三份 golden；设置对话框导航更名刷新了十一份 golden。

## 暂缓

- 删除流程对被引用的备用链采取拒绝而非级联清理其引用；"从所有方案移除"的批量操作如今在单文档内可行，但尚无用户提出。
- hero chip 仅限 web；desktop 外壳在组合 web client 时复用同一 slot。
- `session.list` 摘要不携带生效模型方案，因此 chip 在当前会话变化时经 `session.models` 重读，而非读取摘要字段。
