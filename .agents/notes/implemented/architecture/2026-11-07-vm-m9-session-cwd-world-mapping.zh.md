# Agent Note: VM M9 首批 —— 会话 cwd 世界映射

Status: implemented

[English](2026-11-07-vm-m9-session-cwd-world-mapping.md) | 中文

## 问题

vm 组合下携带宿主 cwd 的会话无法在自己的工作区上行动：`fs-vm` 以调用方 `cwd` 解析相对工具路径并把它当世界路径对待，于是宿主目录（例如 `/home/owner/proj``）变成世界内未命中（`FS_NOT_FOUND`）；bash 的 `workdir` 在 guest 内同样失败。M7 把这一点记录为刻意的 fail-closed 前提（"携带宿主 cwd 的会话仍然指向一个不存在的 in-world 根"），映射本身推迟到路线图 M9 的会话组合长尾。

## 决策

- 引导桥锚定宿主工作区根：只要有效世界为 `vm`，`applyExecWorldBootEnv` 就设置 `DSH_VM_HOST_WORKSPACE_ROOT = process.cwd()`——显式覆盖路径与存储偏好路径都覆盖。锚点是与 `$DSH_EXEC_WORLD` 同族的派生引导事实，不是插件可调项；组合 yaml 零改动。
- `@deepseek-ai/dsh-vm` 持有纯映射（`cwd-map.ts`）：等于或在锚点之下的 cwd 一一映射进 `/workspace`；世界绝对路径的 cwd 原样通过；无锚点时一切 cwd 原样通过（无桥的组合保持原行为）；其余归为 `foreign`，携带两个根供诊断。
- `fs-vm` 的 `resolve` 与 `subprocess-vm` 的 `spawn`/`spawnTerminal` 在 cwd 到达世界之前完成翻译。foreign 的 cwd 以可行动的报文 fail-closed——点名会话 cwd、锚点与 in-world 根——用诚实的诊断取代不透明的世界内未命中（世界依然无法兑现该路径，但现在说明了原因）。
- 绝对工具路径按契约保持世界解释；只翻译会话 cwd（M9 条目"宿主 cwd 会话的 in-world 根映射"的范围）。宿主工作区内容的引导期导入是独立的数据面/产品决定（M5 不可变导入、资产发布），不属于本映射。

## 备选方案

- **在会话创建时改写 header cwd** —— 否决：持久会话数据保持世界中立；映射是组合层事实。
- **两个 provider 各加 Config 字段** —— 否决：锚点不是部署选择而是引导事实；每 provider 配置会在每份组合 yaml 里复制接线。
- **锚点下所有绝对宿主路径都翻译** —— 否决：工具按契约说世界路径（M6）；把翻译放宽到任意路径会模糊路径命名的文件系统，诱发跨世界别名事故。

## 后果

- vm 组合下携带宿主 cwd 的会话现在在 `/workspace` 内解析相对工具路径与 bash workdir，而不是失败；锚点之外的会话以点名双根的映射诊断失败。
- 世界空工作区引导不变：映射后的 cwd 只有在工作区拥有该内容后才在 world 内存在（e2e 先建目录，对应导入后的工作区）。
- `sandbox-policy.workspaceRoot` 维持 M7 原状（vm → `/workspace`）；沙箱约束与 fs 策略只看到世界路径。

## 测试

- `dsh-vm` `cwd-map.spec.ts`：锚点 trim/空白处理；锚点相等、嵌套 `..` 归一、同拼写兄弟不匹配、世界直通、foreign 分类、无锚点直通。
- `fs-vm` `fs.spec.ts`：锚定解析腿（锚点、嵌套、`/workspace` 直通）与 foreign `FS_NOT_FOUND` 诊断。`subprocess-vm` `runtime.spec.ts`：世界 seam 上观察到的翻译后 spawn `cwd` 与 foreign 拒绝。
- `app-boot` `exec-world-boot-env.spec.ts`：vm 解析与显式 `vm` 覆盖时锚点存在、local 时缺席。
- REAL Loader 组合（`exec-world-settings/tests/loader.spec.ts`，stub 世界，CI 可跑）：`cwdMapped` 经组合后的服务解析出 `/workspace/a.ts`，foreign cwd 报映射错误。
- QEMU 门控 e2e（`exec-world.e2e.ts`，真实 provider）：`${anchor}/nested` 下的 `bash` 打印 `/workspace/nested`；`/definitely-outside-the-anchor` 下的 spawn 在请求 guest 之前 fail-closed。
