# Agent Note: Wave-8 上游修复批（Markdown 解析、剪贴板、CJK 强调、重复提醒、拒答、文件上传、摘要路由、错误分类）

Status: implemented

[English](2026-11-24-wave8-upstream-fix-batch.md) | 中文

## 问题

冻结的 wave-8 增量（pin `4b399c39a6`，dsh 0.2.3-alpha.2）中的十项上游修复，纠正了本树同样存在的缺陷。每一项都在移植前对照上游 diff 核实为本树所缺：

1. **大段 Markdown 冻结主线程**——`mdast-util-from-markdown` 2.0.3 对每个列表项 splice 事件数组，`micromark-extension-gfm-table` 2.1.1 对每个单元格复制事件尾部；流式渲染器每个分片都重新解析尾部，因此大表格或长列表会卡住每一帧（官方 `eafa4302a5`）。
2. **CJK 文本之后、标点开头的粗体永远不开启**——`针对**“…”**，` 渲染出字面标记，闭合标记与段落中下一个开启标记配对（官方 `f96500740f`）。
3. **Clipboard API 被拒时复制按钮毫无反应**——`navigator.clipboard.writeText` 被拒后直接返回 `false`，不尝试 `execCommand`（官方 `adc9d1bf64`、`81ee68dfba`、`54330f75e4`）。
4. **`run_code` 子调用污染重复提醒**——嵌套执行与 agent 共用链键，因此程序内发出相同子调用会让一次 `run_code` 调用触发提醒，交错的子调用还会重置真实的循环（官方 `2c4f548d13`）。
5. **菜单在另一个弹窗旁保持打开**——共享右键菜单按钮拦截自身的指针按下，菜单的 `pointerdown` 关闭逻辑看不到那次激活点击（官方 `85416f643a`）。
6. **提供方拒答被报告为畸形响应**——`stop_reason: "refusal"` 落入不支持的 stop reason 分支，丢失已计费的用量和提供方的说明（官方 `e68c033493`，保留 `f250e23202` 的拒答路径）。
7. **图片上传开始时取消轮次可能导致 Host 进程退出**——Node 的 `fetch` 在游离任务中复制 `FormData` 请求体；同一事件循环内中止会使该任务以未处理的 `Invalid state: ReadableStream is already closed` rejection 失败，启动器的致命处理器随之退出进程（官方 `c64f311035`）。
8. **压缩摘要使用了刚刚拒绝历史的路由**——请求溢出后，最新 header 指向拒绝的那条路由；摘要几乎重放相同前缀，该路由再次拒绝，溢出恢复走进死路（官方 `9ebb02afb7`）。
9. **注册表无法路由的失败**——shell 与文件系统参数失败是裸 `Error`；强制后台调用会先弹出审批再失败；单独的 `sandbox_permissions` 被告知补一个该组合无法满足的 justification；工具主体或 `tools/execute` 包装层抛出的取消不带 `ABORTED` 身份；空白的 `web_fetch` URL、畸形的 skill 名、应答方失败和失败的工作流运行都没有 code（官方 `efc62d7b06`、`fc6afa97fe`、`9b4b278b3e`、`4f62401683`、`fda29f726d`、`1784d23da9`）。
10. **传输失败文本没有上限**——`web_fetch` 把整个系统错误放进模型可见的消息（官方 `38921fcac5`）。

## 决定

每项修复都按上游形态移植；本树契约不同之处记录为偏差。

- **Markdown 解析器**：`ui-primitives` 与根目录把 `mdast-util-from-markdown` 固定在 `^2.1.0`，锁文件中所有引用解析为 2.1.0，`micromark-extension-gfm-table` 为 2.1.2。锁文件只改到这些引用：`pnpm update --depth Infinity` 会重新解析无关的传递依赖（tslib、aws-sdk、vitest peer）。
- **CJK 粗体**：`cjkFriendlyStrong` 增加对称的 `cjkStrongOpen` 分支（两个标记、前置 CJK 文本、后接标点）。单星号强调与非 CJK 相邻的情况保持上游解析。`markdown-cjk-strong-open` Web 场景固定组装后的渲染。
- **剪贴板**：异步 API 缺失或被拒时，`writeClipboard` 落到 `execCommand('copy')`，后备路径保持完全（textarea 总会被移除），并把焦点还给复制控件。调用方必须在用户手势中调用：后备依赖瞬时激活，并会替换页面选区。
- **重复提醒**：带 `exec.parent` 的调用既不计数也不重置链；只有模型直接发起的调用（包括 `run_code`）才计入。
- **菜单**：打开的 `Menu` 在其外部的 `aria-haspopup` 控件被激活 `click` 时关闭，并在捕获阶段捕获，因此隔离自身按压的触发器也能关闭它；`isExternalTrigger` 仍然豁免弹窗自行管理的触发器。
- **拒答**：以 `refusal` 停止的 Messages 流先产出最终用量，再抛出 `CONTENT_REFUSED`，并在提供方给出可用说明时保留它。该 code 不在默认可重试集合内。chat-completions 协议保持现有的 stop reason 处理；上游没有为它提供拒答映射。
- **文件上传**：`DeepSeekFilesClient.upload` 自行编码三个 multipart 字段，并以显式 boundary 发送 `Uint8Array`；`request` 把调用方的 header 与归因、认证 header 合并。chat-completions 变体保留其前置的 `purpose=user_data` 字段。
- **摘要路由**：摘要调用及其策略覆盖使用同一个会话路由：产生最新 `assistant/message` 的模型，然后是持久 `model/target` 经 model-policy 解析出的具体目标，再是最新请求 header，最后是 agent 选项。显式配置的 `summarizationProvider`/`summarizationModel` 对仍然优先。应答路由在摘要时通过对会话日志的反向扫描读取。这收窄了[replay token-meter Agent Note](../architecture/2026-07-15-replay-token-meter-service.md) 记录的优先级：选中的目标只在它应答之后，或首次应答之前生效。
- **错误分类**（wave-7 error-base 主线的延续）：
  - `bash`、`pwsh` 以及 `write`/`edit`/`apply_patch` 的沙箱控制器，在配对检查、审批和工作目录设置之前，以 `ToolArgsError` 拒绝 schema 未公开的升权字段——没有沙箱执行器时单独的 `sandbox_permissions` 或非空 `justification`。shell 工具还在同一处拒绝未公开的 `run_in_background: true`，强制后台调用因此不再先弹出提示，并把 command、description 和 `timeoutMs` 违规报告为 `ToolArgsError`。缺少任务运行时为 `ToolContextUnavailableError`。只要升权字段已公开，wave-6 的孤立 justification 容错仍然成立；见 [wave-6 修复批](2026-11-07-wave6-upstream-fix-batch.md)。
  - 取消之后，已开始的工具主体抛出 signal 的 reason 或名为 `AbortError` 但不具备 `HarnessError` 身份的 `Error` 时，注册表保留其 message 并加上 `{ name: 'AbortError', code: ABORTED }`；`tools/execute` 包装层抛出这类值时按同样方式归类，工具主体尚未开始则为 `ABORTED_BEFORE_DISPATCH`。`HarnessError` 与其他失败保持原身份。见[协作式工具取消 Agent Note](../architecture/2026-07-19-cooperative-tool-cancellation.md)。
  - `web_fetch` 的空白 URL、`web_search` 的查询约束和畸形的 skill 名抛出 `ToolArgsError`（`INVALID_ARGS`）。
  - `ctx.userQuestions.ask` 包装应答方：不是 `HarnessError` 的值变为 `UserQuestionError` `PROVIDER_ERROR`，保留原 message 与 cause；其他 `HarnessError` 保留自身的 name 与 code；调用方中止后的失败为 `ASK_ABORTED`。
  - `WorkflowResult` 与 `workflow/end` 携带 `errorCode`，即结束 `error` 运行的致命 `WorkflowError` 的 code；`WorkflowErrorCode` 新增 `RUN_FAILED`，用于没有该 code 的 error 运行，`workflow` 工具以运行的 code 失败（`AGENT_CAP`、`CANCELLED` 或 `RUN_FAILED`）。worker 线程宿主会丢弃 seam 联合类型之外的 code，而不是拒绝整个结果。

## 考虑过的替代方案

- **摘要保留选中模型优先**——否决：这正是所报告的缺陷。切换到窗口更小的模型后，选中的目标指向刚刚拒绝历史的那条路由，摘要会因输入容量不足而失败，或再次溢出。
- **移植上游的 `compactionAnsweredRoute` 会话投影**——本批不采用：本树的 `sessionProjections` 注册表把每个 key 发布到 Client 线路，且没有仅宿主的注册方式，投影会为读取一个 provider/model 对而新增线路契约。扫描只在产出摘要时运行。
- **像上游一样在 `errorCode` 未知时拒绝整个 worker 结果**——否决：宿主对 `Result` 消息的其他字段本就按类型接收，也没有针对畸形结果的失败关闭路径；丢弃该 code 可得到可路由的 `RUN_FAILED`。
- **shell 参数失败保留裸错误，只给新检查定型**——否决：上游的规则是手工检查的参数约束抛出 `ToolArgsError`，而重试、UI 与分析无法只凭文本路由。
- **为 chat-completions 协议补充拒答映射**——未做：上游在拒答工作之前已移除该协议，没有可移植的参考行为；记录为缺口。
- **用 `pnpm update` 刷新锁文件**——否决：它会在整个工作区内移动无关的传递版本。

## 结果

- 600×10 的表格解析约需 170 ms，原先约 1.8 s；6,000 项的列表约需 570 ms，原先约 750 ms；流式重解析会放大这一收益。
- 中文回复中标点开头的片段无需在标记两侧加空格即可加粗；Clipboard 权限被拒时复制按钮可用；`run_code` 程序不再触发或洗掉重复提醒；拒答连同说明一起报告，不再是 `MALFORMED_RESPONSE`；图片上传期间取消不再退出 Host。
- 模型可见文本变化：shell、文件系统、`web_fetch`、`web_search` 和 `skill` 的参数失败带上 `invalid arguments: ` 前缀，`tool/result.error.info` 携带 `ToolArgsError` / `INVALID_ARGS`；被取消的工具主体或包装层报告 `ABORTED`；失败的工作流运行报告其致命 code。已提交的 keyless 快照没有固定任何旧文本。
- 会话一旦持有 assistant 消息，`/compact`、压力压缩和溢出恢复都会交给产生最新一条消息的模型，即使该模型已无法提供服务，直到新选定的模型应答一次；`summarizationProvider` 与 `summarizationModel` 可覆盖这一行为。
- 按目标的压缩策略由运行摘要的同一路由选择，消除了此前摘要目标与策略查找之间的不一致。
- `enableRunInBackground: false` 下的强制后台调用现在以参数错误失败，不再弹出审批。

## 测试

`markdown.client.spec.tsx`（开启分支，两种流式模式）、`apps/web/tests/markdown-cjk-strong-open.e2e.ts`（组装后的 aria golden）、`terminal-block.client.spec.tsx` 与 `chat-branch-tails.client.spec.tsx`（剪贴板后备、焦点恢复、被拒的写入）、`menu-submenu.client.spec.tsx`（隔离的触发器、被认领的触发器）、`repeat-tool-reminder.spec.ts`（嵌套的 `composite` 与 `other` 调用）、`stream.spec.ts` 与 `messages/adapter.spec.ts`（用量之后的拒答、说明、不可用的说明、线路尝试）、`files-api.spec.ts`、`file-store.spec.ts` 与 `files-upload-cancel.spec.ts`（两种协议下经真实 `fetch` 连接回环端点）、`compaction-basic.spec.ts`（应答路由优先于更新的 header 或选择、按应答路由选择策略覆盖、无应答时 routed 先于 options）、`tools.spec.ts`（主体与包装层的取消矩阵）、`tool-bash`/`tool-pwsh`/`tool-fs` 规格（未公开的字段、后台先于审批）、`tool-web.spec.ts`、`tool-skill.spec.ts`、`user-questions.spec.ts`，以及工作流的 `session`、宿主与 `tool-workflow` 规格（跨线程边界的致命 code）。headless 的 `compaction-recovery` keyless 场景回放通过。除既有的覆盖率排除项外，每个改动的源文件逐文件覆盖率为 100%。
