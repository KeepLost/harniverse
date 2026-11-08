# Agent Note: apply_patch 文件编辑（wave-6 吸纳，默认关闭）

Status: implemented

[English](2026-11-07-apply-patch-file-editing.md) | 中文

## 问题

编辑多个文件或分离区域需要逐点调用字面量编辑，而 shell 或 Python 打补丁完全绕过 `fs/*` intent 瀑布——观察策略、版本防护和沙箱围栏都看不到这些写入。Wave-6 owner 裁定吸纳官方 `apply_patch` 能力：采用 Codex 兼容的 `input` 参数与钉死的 `rust-v0.158.0` 解析/匹配语义，注册默认关闭。

## 决策

- **`@deepseek-ai/dsh-fs-patch`** 逐字移植官方纯库（解析器、顺序匹配器、LF 规范化、结构化匹配失败；147 个 fixture 测试原样通过）。公开语法类型镜像到[文件系统参考](../../../../docs/subsystems/filesystem.md)。
- **`FileSystem` seam** 增加 `patchText`、`deleteFile`、`moveFile` 与 `fs/delete-intent` 单槽防护；`FS_PATCH_MISMATCH`、`FS_SAME_TARGET` 与运行时 `FS_ERROR_CODES` 常量进入共享词汇。local 与 sandbox 提供方在既有原子写/变更锁原语上实现三操作（移动按规范序锁定双目标，发布后源删除失败以 `sourceDeleted: false` 报告；被移动文本本身超出 diff 预算时跳过目标基准；Win32 DACL 复制以目标真实存在为前提）。SSH 提供方经 helper RPC 以校验 schema 转发 `fs.patch`/`fs.delete`/`fs.move`；`fs-vm` 在宿主侧策略检查下基于世界 `VmWorldFs` 实现三者。
- **`apply_patch` 工具**（移植的执行器：整份补丁预检——语法、解析目标、含重复路径与移动端点的观察态模拟——随后按序提交、逐操作重取防护、首失败即停不回滚、`stat` 比对的 `unknown` 分类、部分移动报告）仅在 `tool-fs.applyPatch: true` 时注册。没有随发行版组合设置它，因此模型可见面与全部录制快照不变。工具与 `write`/`edit` 走同一 `fs/write-intent`/`fs/edit-intent`/`fs/delete-intent` 瀑布，挂载的观察策略按操作生效。
- 官方 testkit 的 `executeModelToolFixture`/`executeToolFixture` 与工作目录 fixture 以本地测试 fixture 形式内联，基于我们的单调用 `ctx.tools.execute`；PTC-executor 等价性测试与 `dsh-util-values`/executor 插件依赖未携带（它们是本吸纳之外的官方架构件）。

## 考虑过的替代方案

**维持 shell/Python 打补丁。** 无观察轨迹的未防护写入；吸纳裁定已否决。

**从我们的字面量编辑重推工具。** 补丁语法与顺序匹配器是训练进 Codex 系模型的面；钉住官方解析器与匹配器让熟悉的补丁行为完全一致、匹配失败保持结构化。

**默认注册。** 官方 Note 刻意以 `applyPatch: false` 交付，保证录制请求预期可比，直到评测数据支持翻转；我们逐字继承该立场。

## 后果

选择开启的组合多一个工具 schema 与提示段；其余组合字节不变。提供方子类必须实现三个新抽象操作。被拒补丁不改变任何内容；已提交补丁可能中途停止并保留已完成操作，调用方重试前需重读受影响文件。`moveFile` 的两个效果彼此独立：目标已发布而源保留是终态并如实报告，从不回滚。

## 测试

`fs-patch` 147/147；`fs-local` 220/220（移植 patch-mutations：hunk、移动、取消检查点、Windows DACL 门控、部分移动、非预期删除缺陷）；`fs-sandbox` 28/28（三操作逐模式围栏）；`tool-fs` 445/446（执行器预检/提交/呈现套件以本地 fixture 移植；写权限失败用例在 root 下自跳过）；`fs-vm` 22/22；`ssh` 252/252；触及的每个 `src` 文件定向覆盖 100%；typecheck 0。
