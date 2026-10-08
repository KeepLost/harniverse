# Agent Note: 面向老机器的遗留编码支持

Status: implemented

[English](2026-10-06-legacy-encoding-support.md) | 中文

## Problem

本 Harness 此前是纯 UTF-8 文本接缝：遗留编码文件的所有读取都失败（`FS_NOT_TEXT`）；UTF-8 BOM 在读取时被静默剥除、写回时丢失（唯一的静默损坏 bug）；遗留 locale 机器的 shell 输出被损耗解码为 U+FFFD；工作台预览对一切非合法 UTF-8 直接拒绝且完全没有 NUL 闸门。老机器（ANSI 936/932/949/950/125x 的 Windows、`LANG=zh_CN.GBK` 一类的 POSIX 主机）的文件完全无法读取与编辑。

## Alternatives considered

- **`textEncoding` 能力接缝（Definition + Provider + Consumer）。** 本范围否决：收敛后的决定只共享纯函数（解码、编码、先验、候选顺序），不需要按部署替换，服务接缝只会为零收益引入 bundle 行与治理成本。本记录取代调研中的能力接缝草案，不是永久排除——将来需要严格 UTF-only Provider 的部署可在同一库背后再加。
- **统计检测（chardetng-wasm）。** 排除：主机先验加严格校验已覆盖「老机器 + 本地区编码」目标，wasm 依赖、阈值标定与置信分层随之取消。这收窄了 2026-07-26 NIH 审计记录中「model-visible FS_NOT_TEXT 漂移」否决 chardet 一条的适用范围；原记录不改——本特性是经 owner 决策有意改变可读文件集，并不重新引入 chardet。
- **各界面各自检测。** 否决：fs 工具、预览与子进程输出必须对「文件编码是什么」达成一致，因此由一个库（`dsh-fs-codec`）统一拥有解码/编码/先验/候选顺序。
- **`FS_ENCODING_READONLY`、置信分层、声明编码解析（`.editorconfig`/`.gitattributes`/`.vscode`）、无 BOM UTF-16 启发、字节透明 grep、PTY、SSH helper。** 不在本轮范围，列入各属主 README 的 Known Limitations。

## Decision

- **一个纯库** —— `@deepseek-ai/dsh-fs-codec`（iconv-lite 精确钉版 0.7.3，koffi 3.1.1 绑定 `GetACP`/`GetOEMCP`）：严格解码 = U+FFFD 一票否决 + 字节等值重编码；单字节自动候选额外通过控制字符比例；所有解码一律作用于单一整段缓冲（钉住 iconv 的 GB18030 流式缺陷——4 字节序列跨 64 KiB 分块时丢一个码元）。
- **有序候选走查** —— 显式 `encoding` → 粘性旧决定 → BOM（UTF-8/16LE/16BE）→ 严格 UTF-8 → 主机遗留页（Windows 经 koffi 取 ACP；POSIX 按 `LC_ALL > LC_CTYPE > LANG` 字符集）→ UTF-8 locale 的语言页（zh-CN→GB18030、zh-TW/HK→Big5、ja→Shift_JIS、ko→EUC-KR、ru/uk/bg→windows-1251、pl/cs/hu 等→windows-1250、西欧→windows-1252，另有 el/tr/he/ar/vi/th）→ 配置的 `fallbackEncodings`。显式名要么成功要么点名失败；全部失败时列出能解码该文件的编码，供带 `encoding` 重读。
- **零回归边界** —— 合法 UTF-8 文件读取逐字节不变，唯一差异是 UTF-8 BOM 现在被记录并在受守卫写回时复现（修 bug）；含 NUL 且无 UTF-16 BOM 的文件仍是 `FS_NOT_TEXT`（读取与之前一样只采样前 8192 字节；编辑与遗留候选对整个 buffer 执行闸门）；新文件仍写 UTF-8 无 BOM；编辑仅在读取通过往返校验时按原编码与 BOM 写回；不可映射字符在暂存之前以 `FS_UNMAPPABLE` 拒绝——绝不写 `?`。
- **读取接缝上的 `utfOnly`** —— `readText`/`streamText` 接受 `{ encoding?, utfOnly?, onDecision? }`；`utfOnly` 把读取限制在 UTF 家族，严格 UTF-8 消费方（skills、agent 指令、配置）保持既往行为——GBK 的 SKILL.md 仍被忽略而不是变成可读。`onDecision` 把最终决定递给需要标注输出的消费方。LSP 与附件流无需改动（经默认解码自动获益）；本轮 write/edit 不加参数。
- **模型面** —— `read` 新增经校验的可选 `encoding`（未知名在参数解析期报错并列近名候选）；非 UTF-8 读取在信封内追加一行 `[Encoding: <name> (<source>)]`；UTF-8 输出逐字节不变。`str_replace_editor` 的 `view` 得到同款标注，其修改经粘性决定写回，工具层零改动。
- **子进程输出** —— `SubprocessCollect` 新增可选 `decoding` 规格；收集器对整个保留窗口逐行解码（合法 UTF-8 行保持 UTF-8，非法行回退到流级遗留页），保留不完整的尾部序列（返回的 `nextOffset` 可能早于最新保留字节），把从外部字符中间偏移恢复的窗口按 UTF-8 处理而不回退。`pwsh-local` 保留 UTF-8 preamble 并回退到主机 OEM、ANSI；`bash-local` 从子进程最终 locale 派生规格且绝不改写 `LANG`；UTF-8 主机逐字节不变。
- **预览** —— `workspace.files.read` 经同一走查解码，支持显式 encoding 请求参数与 additive 响应字段（`encoding`、`encodingSource`、`bom`、`eol`）；工作台头部显示文本编码标签，并提供固定列表的「以编码重新打开」选择器（作用域为该标签页）。

## Consequences

- 粘性决定存于提供方，按 target key 记录、随版本漂移作废、处置时清空（HMR）；observation policy 零改动（`FsObservation` 仍为 `{present,version}|{absent}`）。
- `FS_UNMAPPABLE` 进入闭合的 `FsErrorCode` 联合；无非测试代码的穷尽 switch 需要同步。
- 流式读取遇遗留编码退化为一次整缓冲解码后再切块，内存上界为文件大小（与始终整读的编辑读取一致）。
- 覆盖遗留文件现在返回解码后的 `before` 基线，其 diff 卡片从整文件升级为 hunk——已在快照工作中记录的可见改进。
- 上游 DSH 同步必须按本记录核对 `dsh-fs`（读取 opts、`FsTextEncoding`、`FS_UNMAPPABLE`）、`dsh-fs-local`（解码/写回）、`dsh-subprocess`（collect 解码）、两个 shell 执行器以及 `workspace.files.read` wire schema。

## Verification

- `packages/fs/fs-codec/tests/{codec,priors,output}.spec.ts` —— 严格解码、往返、控制比例、候选顺序与拒绝消息、主机先验（注入 Win32 加载器）、带行列的编码拒绝、GB18030 64 KiB 回归钉、逐行输出解码（含外部切片规则）。
- `packages/fs/fs-local/tests/encoding.spec.ts` 及扩展的 `fsio`/`filesystem` 套件 —— 逐编码字节精确 read→edit→write 往返、编辑与受守卫覆写的 BOM 保留、NUL/utfOnly/detect 闸门、fallback 配置与早失败、粘性生命周期与 HMR 清理、不可映射拒写且文件未动、流式遗留文本。
- `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` 与 `packages/context/agent-instructions/tests/agent-instructions.spec.ts` —— UTF-only 边界保持（GBK 的 SKILL.md/AGENTS.md 仍被忽略）。
- `packages/fs/tool-fs/tests/{tools,read-render,error}.spec.ts` 与 `packages/fs/tool-str-replace-editor/tests/tools.spec.ts` —— `encoding` 校验与近名候选、标注渲染、UTF-8 逐字节不变、`FS_UNMAPPABLE` 补救句。
- `packages/subprocess/subprocess-local/tests/spawn.spec.ts`、`packages/shell/{pwsh,bash}-local/tests/executor.spec.ts` —— 收集器解码（随机切块、保留尾部、GB18030 跨块）与执行器规格选择（注入先验）。
- `packages/host/apiproxy/tests/workspace-inspector.spec.ts` 与 `packages/client/ui-workspace/tests/workbench-preview.client.spec.tsx` —— 预览解码、显式重开、NUL 拒绝、截断裁剪；编码标签与重开选择器。
- `examples/acp-agent` keyless 快照 —— 既有 `fs-*` 场景逐字节重放一致；`fs-read-encoding` 在钉定 `zh_CN.GBK` 场景环境下钉住 GBK 读取→标注→编辑往返。
