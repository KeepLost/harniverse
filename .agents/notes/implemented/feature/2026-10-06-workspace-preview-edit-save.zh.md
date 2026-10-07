# Agent Note: 工作台预览「编辑 + 保存」（方案 B 插件对）

Status: implemented

中文 | [English](2026-10-06-workspace-preview-edit-save.md)

## Problem

工作台预览在设计上于每一层都是只读的：`workspace.files.*` 为 `harniverse.observe` + read，Host 以 `O_RDONLY|O_NOFOLLOW` 打开文件，读取只返回 1 MiB 前缀且不带版本号，UI 不暴露任何变更动作。直接经该表面"读了再写回"会截断大文件、丢失 BOM、规范化换行，并在无冲突检测的情况下覆盖并发修改（父工作区的调研 `docs/investigations/02-preview-edit-save.md` 记录了参考项目的失败模式）。Agent 侧早已具备正确的写原语——带 `replaceIfVersion` 的 `ctx.fs.writeText`（按 target 锁、私有暂存、原子发布、mode/DACL 保留）——但缺少面向用户的路径。

## Alternatives considered

- **在 apiproxy 与 ui-workspace 原地扩展（方案 A）。** 否决：编辑能力无法按组合拆卸，CodeMirror 会进入 `startup: critical` 路径，且包的只读身份、invariant 与 README 契约全部翻转，同时业务契约继续堆积在 legacy proxy，与 Typert 方向相悖。
- **经会话执行世界写入（方案 C）。** 否决作为主路径：工作台是 Workspace 作用域（多会话共享、无会话也可用），"记到哪个会话的观测表"没有自然答案，且 Agent permission preset 会约束一个审批者就是用户本人的动作。
- **复用参考项目的私有 HTTP 路由。** 否决：web server 不承载鉴权；业务变更必须经声明了 capability 的已鉴权 `/api` 承载。

## Decision

- **按调研的方案 B 与第七节推荐默认值交付插件对。** Host：`@deepseek-ai/dsh-workspace-file-write`（`ctx.workspaceFileWrite`，Typert `@Remote`，`harniverse.operate`，Workspace-id 作用域）提供 `open`/`stat`/`save`。Client：`@deepseek-ai/dsh-client-ui-workspace-editor`（CodeMirror 6，精确钉版）注册进 ui-workspace 的两个新洞——`workbench.preview.document`（抽屉位）与 `shell.overlay.preview.document`（overlay 位），同一 owner 契约、同一占用者。缺少编辑器行时预览与之前字节一致。
- **open 完整或拒绝**（D1c、D10、D13）：完整读取 ≤ 1 MiB、经共享 codec 链解码，返回 `FsVersion` 与 `{encoding, encodingSource, bom, eol}`；混合换行（`mixed-eol`）、不可解码（`not-text`）、超限、符号链接、`.git` 段、越界均类型化拒绝。内容以 LF 规范化下发。
- **save 复用 Agent 的原语而非复制它**（D2b、D5a）：在以规范 Workspace 目录为根的显式 `workspace-write` 策略下调用 `ctx.fs.writeText(replaceIfVersion)`，写入因此与 Agent 工具共享 fs-local 的按 target 锁，并继承原子发布与 mode 保留。编码、BOM 与换行风格在 CAS 窗口内从磁盘文件重新推导——已交付的 sticky-decision 写回使 Host 成为权威，线缆只携带 `{content, baseVersion, saveId}`（这是对调研 `eol`/`bom` 线字段的偏差，封死了缺陷客户端破坏字节的口子）。不可映射字符连同行列拒绝（`FS_UNMAPPABLE` 语义上浮）；版本陈旧以 `stale-version` 连同当前版本拒绝；`saveId` 补齐 Typert 路径缺失的幂等。
- **不记录 Agent 观测**，因此 Agent 下一次守卫写入得到 `FS_STALE_VERSION`；提交点之后服务发出 `workspace-file/saved`，并向 canonical cwd 为该 Workspace 路径的每个活动会话注入一条非唤醒、仅含路径的提示（D6b 语义）——每次保存至多 32 个会话，同一会话同路径 10 秒间距。
- **草稿放在编辑器插件自有 store**，按 机器/Workspace/路径 键控，携带 `{draft, baseVersion, eol, encoding, bom, status, conflict?}` 与序列化的 `EditorState.toJSON({history})`；store 在 `apply` 中创建一次，在放置位切换（卸载即序列化、挂载即恢复）与机器重注册（条目仍归属其机器）中存活。保存绝不进入 ui-workspace 的请求围栏，因此切换 Workspace 不会中止在途保存；`beforeunload` 守卫覆盖页面离开（D8a——文件内容永不进入浏览器持久化）。
- **冲突按 D5a**：版本 CAS 加冲突条（经既有 `DiffBlock` 的统一 diff 对比、放弃并重新加载、确认覆盖）。外部改动经文件级 `watchFiles` 订阅发现，且只与 `stat` 的 `FsVersion` 比较——watch 帧版本格式绝不与基线版本比较（P1）；编辑器自身保存的回声按版本相等抑制。
- **Escape 与焦点按 P3**：焦点位于 `[data-workspace-editor]` 内部时，预览的 window 捕获关闭让位；编辑器键map 在搜索面板自有绑定之后处理 Escape，否则请求所有者关闭；预览焦点选择器补上 `[contenteditable="true"]`；所有者经 `onDirtyChange` 得知脏事实后，在关闭或收起该文档前先确认。
- **CodeMirror 精确钉版**（D9、D13）：`state 6.7.6`、`view 6.43.13`、`commands 6.11.1`、`language 6.12.4`、`search 6.7.2` 加最小语言集；全部内联进编辑器插件自己的 client bundle（client bundle 每插件产出单一 `client.js`，没有动态 chunk 机制，按插件组合即懒加载边界）。不引入 `@codemirror/merge`（D7a）。

本注记部分取代 [工作台注记](2026-08-28-workspace-workbench.md) 中"工作台保持只读"的条款：工作台的检查 RPC 与 store 仍只读，但可以在预览的文档洞中组合编辑占用者。该注记对包含检查与 slot 纪律决策仍然有效。

## Consequences

- 仅持 `harniverse.observe` 的主体依旧不能编辑（Remote 要求 `operate`，与 `terminal.write` 同级）；observe-only Grant 保持只读预览。
- 进程内锁在同一 Host 进程内串行化用户保存与 Agent 工具写入；其他进程仍保留与 Agent 工具相同的 probe→rename 残余窗口。
- 提示文本模型可见并因此经 inbox 入日志；其逐字文本由 loader-composition 测试与包 README 钉住。
- `dsh-workspace/src/types.ts` 改从 `@deepseek-ai/dsh-session/types`（而非 root）导入 `SessionId`，且 `tsconfig.base.json` 新增 `@deepseek-ai/dsh-workspace` 与 `/types` 的 paths 条目，使生成的 Remote 投影的类型子路径在 Client 程序中不携带 Host `Context` 合并。

## Verification

- `packages/host/workspace-file-write/tests/service.spec.ts` — 路径闸门（混合换行、超限、符号链接、`.git`、越界、缺失、目录）、解码事实（BOM、GB18030 legacy）、保存 CAS（stale 带当前版本、`saveId` 重放、非法 id）、编码忠实写回（GB18030 字节、UTF-8 BOM、CRLF 还原）、不可映射拒绝带行列且字节精确不发布、mode 保留、保存字节上限、提示目标与形状。
- `packages/host/workspace-file-write/tests/loader-composition.spec.ts` — 经 Loader 启动真实 `cordis.yml`（storage/domain/workspace/agent/agent-loop/fs-local 栈），提供可编辑 open、字节精确保存、带当前版本的 stale 拒绝，以及向活动会话注入的逐字 inbox 提示。
- `packages/client/ui-workspace-editor/tests/` — `editor-controller.spec.ts`（加载/脏/保存/冲突/覆盖/重载、watch 回声抑制、机器分区、条目上限、草稿存活）、`editor-document.client.spec.tsx`（经真实 CodeMirror 视图的脏标记、保存按钮契约、冲突条、未占用的 Escape、两种只读回退）、`apply.client.spec.ts`（两声明之后的成对事务安装、重声明后重装）、`invariant.client.spec.ts`。
- `packages/client/ui-workspace/tests/` — `preview-document.client.spec.tsx`（按族占用、截断保持只读、Escape 让位）与 `workspace-workbench.client.spec.tsx` 的脏守卫用例；既有 workbench-preview 与 workspace-workbench 规格原样通过。
- 留给 CI/owner：「用户保存 → 下一模型请求携带提示」的 keyless 快照场景（录制需要 provider key），以及组装后 bundle 的 Grant 认证浏览器 E2E。
