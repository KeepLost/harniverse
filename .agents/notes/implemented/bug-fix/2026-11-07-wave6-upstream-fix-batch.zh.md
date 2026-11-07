# Agent Note: Wave-6 上游修复吸收批（参数容错、charset 恢复、read 指引、锁定部署）

Status: implemented

[English](2026-11-07-wave6-upstream-fix-batch.md) | 中文

## 问题

上游 0.2.2-rc.1 增量（`UPSTREAM-ABSORPTION-REVIEW.md` wave-6 survey，pin `fcc0ad4621`）中的四个已实现决定解决了本树同样存在的缺陷：

1. **未被使用的可选字段导致无谓重试**——`grep` 把恰好为空的 `include` 当非法值拒绝；`update_goal` 对所选 action 用不到的已知字段（`objective`/`max_goal_rounds`/`blocked_reason`）只要非空就拒绝；write/edit/bash/pwsh 把不带 `sandbox_permissions` 的孤立 `justification` 当配对错误拒绝。这些值都不改变所请求的操作，拒绝它们不保护任何状态（官方 `2026-09-20-unambiguous-tool-arguments`）。
2. **畸形 charset 声明杀死可读页面**——`charset=utf-8,gbk` 整串传给 `TextDecoder` 直接抛出，正文从未被读（官方 `2026-10-26-malformed-charset-declaration`）。
3. **read 指引只点名 `cat`**——生产会话用 `sed -n X,Yp` 读行区间 60 次而不去用 read 工具（官方 `2026-10-26-read-guidance-line-ranges`，#6057）。
4. **Python 运行时部署无视 lockfile**——`pnpm deploy --legacy` 按范围重新解析 registry 版本（tslib 锁 2.8.1 可装出 2.9.1），`scripts/build-exe-for-python-sdk.ts` 当时就带着 `--legacy` 与 `--config.auto-install-peers=false`（官方 `2026-11-01-locked-python-runtime-deploy`）。

## 决策

- **参数容错（逐工具、非通用放宽）**：`parseGrepArgs` 把恰好为空的 `include` 视为省略（纯空白仍然非法）；`update_goal` 忽略所选 action 用不到的已知字段，任意取值不再拒绝（`blocked` 仍要求 `blocked_reason`，阈值与授权校验不变）；`validateEscalationArgs` 不再拒绝孤立 `justification`——真正升权（带 `sandbox_permissions`）仍要求非空理由并走审批，重复模式对仍由 `normalizeRedundantEscalation` 先行剥离。规则留在各工具内，不建立通用字段强制转换政策。
- **charset 恢复**：`decoderForCharset` 对整串不支持的声明按逗号/空白拆分标签，任一标签属 WHATWG UTF-8 标签集即返回 **fatal** UTF-8 解码器；否则在读正文之前抛 `WEB_UNSUPPORTED_CONTENT_TYPE` 并取消流。fatal 解码失败在 provider 映射回同一错误码并保留 cause。不含 UTF-8 标签的声明、单标签 legacy 解码、`<meta charset>` 忽略均不变。
- **read 指引**：并入官方措辞——点名 `cat, sed, head, or tail` 并新增"用 offset 与 limit 读行区间或续读大文件"——保留本树自有的行号、`line_byte_offset` 续传与 legacy 编码提示句。30 个 pinned system-prompt sidecar 经 `test:snapshot:refresh` keyless 重录。
- **锁定部署**：deploy 改用 pnpm 默认策略（从工作区 lockfile 派生生产 lockfile 并 frozen 安装），去掉 `--legacy` 与 `auto-install-peers=false`；新增 `--config.inject-workspace-packages=true`（默认部署的前提）与 deploy 专用 `scripts/python-runtime-deploy.pnpmfile.mjs`——其 `hooks.updateConfig` 把 `allowBuilds` 中相对 `name@file:<path>` 审批键翻译成派生 lockfile 使用的绝对 `file://` 身份，审批/拒绝与 strictDepBuilds 校验本身不变。`restoreLegacyHoists` 更名为 `verifyStagedDependencies`（默认部署会物化全部直接依赖，该函数保留为完整性校验与兜底恢复）。本树无 `file:` 直接依赖，无需官方 pnpmfile 的审批翻译之外的逻辑。

## 备选方案

- **完整严格 schema 适配**（官方也列为独立工作）——推迟：与本次四个确定性语义修复正交。
- **规范化所有空/零值**——否决：这类值可以是有意义输入（空文件内容、数值上限）。
- **charset 按声明顺序取第一个可解码标签**——否决：单字节编码会把解码失败变成静默乱码（`C2 A9` 在 GBK 与 UTF-8 下都有释义）；只有 UTF-8 是有界恢复。
- **保持 legacy 部署并补 integrity 记录**——否决：接受 lockfile 未选定的版本，且下次兼容发布会再次失败。

## 后果

- 模型回显的未用字段不再产生失败重试；升权与 blocked 的强制条件全部保留。
- 多标签声明中含 UTF-8 的畸形响应现在可读；其下非法 UTF-8 字节以结构化错误浮出而不是插入替换字符。
- 所有渲染 read 指引的录制请求期望已更新；goal 工具 schema 描述随语义更新（`applied only by` / `ignored by other actions`）。
- 暂存产物版本可追溯到工作区 lockfile；部署期构建脚本审批以绝对身份继续生效。ssh helper 的独立 closure 清单不在本修复范围（同官方）。

## 测试

`tools.spec.ts`（空 `include` 省略、纯空白仍拒绝）、`escalation.spec.ts`（孤立 justification 通过、升权配对与空理由仍拒绝）、`tool-goal.spec.ts`（跨 action 忽略矩阵、blocked 必填与阈值仍拒绝）、tool-bash/tool-pwsh（孤立 justification 不再报错）、`fetch-http.spec.ts`（恢复矩阵、fatal 拒绝、provider 流取消）、snapshot 套件 119 场景 keyless 重录后全绿。部署修复以真管线验证：`build-exe-for-python-sdk.ts --skip-build` 全程通过（closure 校验、default deploy、SEA 打包 204.4MB linux exe、同步 runtime），`smoke-python-runtime.py --scenario direct` 通过。
