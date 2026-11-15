# Agent Note: Wave-7 立即吸纳批——前导状态分类、错误分类体系基座、只读并发与入口导出门禁

Status: implemented

[English](2026-11-14-wave7-immediate-absorb-batch.md) | 中文

日期:2026-11-14。范围:`packages/llm/llm-pi-ai`(前导状态分类)、新 `packages/util/error` 与 `dsh-fs`/`dsh-fs-local`/`dsh-fs-sandbox`/`dsh-tool-fs`/`dsh-tool-fs-search`/`dsh-attachment`(错误分类体系)、五个包的九个工具注册(并发声明)、`scripts/verify-plugin-entry-exports.ts`(门禁)。上游源版本:deepseek-harness `4c1cf20cb1`(dsh 0.2.2-rc.3),冻结的 wave-7 pin;四行是 wave-7 勘测的立即可吸集合,owner 2026-11-14 批准。

## 问题

四个上游增量各自关闭我们以相同形状持有的缺口:pi-ai 失败分类把内嵌上游 401 的网关 500 误读为认证失败;`HarnessError` 住在 `dsh-llm`,其下的包(`dsh-attachment`)为避免环只能重实现该形状,且宿主 errno 逃逸暴露原始 Node 错误而非 `FsError` 分类;只读工具集合窄于并行执行器契约允许的范围;仓库仅限 client 层的插件导出纪律没有机器门,值导出可以在任何 Host 入口上无声累积。

## 决策

- **前导状态分类(行 8,PR #303)。** `classifyPiAiError` 的状态规则只读前导 `^[45]\d\d\b` 状态(AUTH 401/403、RATE_LIMIT 429、REQUEST_BODY_TOO_LARGE 413、INVALID_REQUEST 400、SERVER 5xx);措辞规则仍扫全句。共享的 `isRequestBodyTooLargeError` 拆出仅措辞的一半(`isRequestBodyTooLargeWording`),裸 413 测试移到前导状态之后,`llm-deepseek` 行为不变。
- **错误分类体系(行 10,PR #304)。** `@deepseek-ai/dsh-error` 持零依赖基类;`dsh-llm` re-export 同一个类;`AttachmentError` 直接继承基类(防环注释随环一起消失)。`fsErrorFromErrno` 在每个逃逸点分类宿主 errno(ENOENT/ENOTDIR→`FS_NOT_FOUND`、EACCES/EPERM→`FS_PERMISSION_DENIED`、EISDIR→`FS_NOT_REGULAR_FILE`、其余→`FS_IO_ERROR`):fs-local 的 resolve/probe/stat/list/read 站点把 ad hoc 助手折叠进去,fs-sandbox 包含层 stat 同步分类。`FsError` 固定字面量名。`FS_ALREADY_EXISTS` 以真实生产者(str-replace-editor `create`)入表。工具边界采用类型化失败:read/write/edit/glob/grep 参数失败抛 `ToolArgsError`;`read_image` 抛 `ImageInputError`(恰 `IMAGE_UNSUPPORTED_MODEL`/`IMAGE_UNSUPPORTED_FORMAT`)或新的 `ToolContextUnavailableError`,`saveImage` 拒绝保留 `AttachmentError` 码并补上带路径与补救的消息、原始错误作 cause——每个拒绝都在 `tool/result` 记录 `{ name, code }`。
- **只读并发(行 9,PR #305)。** glob、grep、`job_list`、`schedule_list`、`cordis_inspect_list`/`cordis_inspect_query`、三个 MCP resource 工具声明 `isConcurrencySafe: () => true`;`job_output` 保持独占(读游标),变更类 scheduler 与 Cordis 工具亦然。
- **入口导出门禁(行 18,PR #306)。** `verify-plugin-entry-exports` 经 Host 再 Client 编译面编译全部插件入口,拒绝 Loader 字段与 Service-Definition/错误类之外的值导出;141 包的 830 个门禁前导出基线化为债务(之后新增的行需要领域所有者确认);规则落在 `docs/defensive-patterns.md`,门禁挂 CI 静态道。

**记录在案的偏离:** `FS_ALREADY_EXISTS` 挂我们的 str-replace-editor(官方 create-only 命令族我们恰在此发货);`saveFailureDetail` 的 switch 保留开放 default 而非 `assertNever`(我们的附件码表是开放字符串联合);官方的按边维度码与 16 位 PNG 转换补救未移植(此处无生产者);`cordis_inspect_self` 与 `team_task_*`/`list_agents` 名单未声明(此处未发货/不在官方声明集);shell/sandbox/subprocess 错误类保留 `dsh-llm` 导入(re-export 下仍有效——重新搬家是无收益的翻动)。

## 备选方案

**Port the官方中间态的七码 `ImageInputError`。** 上游先发七个工具自有图像码,再收敛为两个、store 码保留为 `AttachmentError`;我们直接移植最终形态,持久化码表不折腾两遍。

**用 `assertNever` 封闭附件 switch。** 官方的穷举 switch 依赖封闭码联合;我们的码表是开放字符串联合,switch 记录开放 default。

**把全部 `HarnessError` 导入搬家到 `dsh-error`。** 六十多个导入点经 re-export 原样可用;搬家是无行为回报的机械翻动。

**对 830 个基线导出做总翻修而非基线化。** 门禁的价值在止住新债、基线随机会性收缩;总扫会撑爆本批并触碰四行无关的包。

**把行 10 拆成两个 PR。** 注册面目录(config/cordis/doc graphs)内嵌两半的行引用;拆分使第一个 PR 的目录校验对自身树失配,该行以三提交单 PR 落地。

## 后果

- read_image 拒绝现在在 `tool/result` 持久化 `error.info`;read-image-text-route 快照记录新字段(经 `DSH_SNAPSHOT=refresh` 重录),v0 会话契约 digest 无需变更——它只基线化泛型 `{ name: string; code: string }` 形状。
- 同批只读工具调用现在真正重叠(有界池,默认 10);结果仍按模型序提交,会话格式与模型可见顺序不变。
- Host 插件入口上的新值导出会挂 CI,直到移入内部模块或经 owner 确认后基线化;基线随导出移除单调收缩。

## 测试

- 前导状态矩阵的 RED-first 行(`convert.spec.ts`,79/79,含六条移植 fixture);errno 表 spec(`fs/tests/errno.spec.ts`)加 fs 家族套件(971 测)与 `AttachmentError` 消费面(581 测);`read-image.spec.ts` 的类型化失败块(42/42)按类钉 `{name, code}`;每个新声明的逐包 executionMode 断言(五包 190 测);门禁 spec 套件(11/11)与全树绿跑(`830 listed exports`)。
- 一次重录后快照套件回放绿;typecheck、目标 oxlint、runtime-closure、目录(config/cordis/doc-graphs 含双语镜像)、README 门禁与翻译配对(1334 对)本地全过;各 PR CI 绿。

## 相关

wave-7 勘测行见上游吸收评审(wave-7 表,行 8/9/10/18);pi-ai 0.87.1→1.3.0 大版本(行 7 的载体)仍是设计先行,未在此触碰。
