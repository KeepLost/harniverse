# Agent Note：工作台树内新建与提交连线历史

Status: implemented

[English](2026-10-13-workbench-tree-create-and-git-history.md) | 中文

## Problem

工作台的文件栏此前只能看：既不能新建文件或文件夹，也无法把展开的树一次性折叠回根。变更栏把最近的提交渲染成不可点的文本——没有引用徽标，没有相对上游的领先/落后，看不到一次提交改了哪些文件，也无法只读查看某个提交里单个文件的 diff。底层同样欠缺：workspace-file-write Remote 只能覆盖已存在的文件，`workspace.git.*` ApiProxy 域既不返回父提交哈希也不返回引用装饰，客户端画图没有数据来源。

## Decision

**新建留在写 Remote 之后；读接口保持只读。** `dsh-host-workspace-file-write` 新增 `createFile` 与 `createDirectory`（`harniverse.operate`）：空文件经由后端 `createIfAbsent` 暂存原语发布；目录逐段校验创建，每个中间段都做规范路径复核（realpath 等于词法路径、拒绝符号链接、拒绝 `.git` 段），最终条目必须不存在（`exists`），发布后还需用 no-follow 描述符复核才返回。语义是严格的，不是 `mkdir -p`：已存在同名目录会拒绝。`apiproxy` 的 `workspace.files.*` 与 `workspace.git.*` 保持 observe-only。

**工作台通过 inject 声明取得 Remote。** `dsh-client-ui-workspace` 声明 `remote.workspaceFileWrite`（客户端 api-remotes 装配在所有 web 组合里都会挂载它），并在注入面上与读回调并列暴露 `createFile`/`createDirectory`。文件栏工具条新增新建文件、新建文件夹、刷新与折叠全部。就地输入框落在目标目录内——目标取最近交互的目录（展开的文件夹，或打开文件所在的父目录），缺省为根——并接受 `a/b/c.md` 形式的路径，创建成功后展开链会逐级展开并重列中间目录；新建的文件直接进入预览。回车提交、Esc 取消、失焦提交，`exists` 拒绝时输入框保持打开并显示本地化消息，其余失败码透出线上消息。

**输入框存在期间独占 Esc。** 预览的 window 捕获层与各抽屉层（原本按 Esc 关闭各自表面）现在对 `[data-workbench-create]` 内的目标放行，输入框自身停止原生传播，因此取消命名不会顺带关闭预览或抽屉。这与既有的 `[data-workspace-editor]` 所有权一致。

**宿主返回画图所需的数据；客户端负责绘制。** `workspace.git.commits` 新增 `parents`（`%P`）与从 `--decorate=full` 解析的 `refs`（HEAD、本地、远程、标签、其他；`current` 标记检出分支），并改用 `--topo-order` 保证父提交在窗口中总排在子提交之后。`workspace.git.status` 新增 `upstream`、`ahead`、`behind`（porcelain 头部本就携带，此前被丢弃）。域内新增两个 observe-only 方法：`commitFiles {hash}`（`diff-tree --name-status -M`，合并提交按第一父提交比较，根提交用 `--root`，500 文件上限，重命名的原路径记入 `previousPath`）与 `commitDiff {hash, path}`（同一比较形态加 `-p`、`--no-ext-diff --no-textconv`、`--literal-pathspecs`）。两者在任何 spawn 之前都把哈希校验为完整 40 位十六进制字面量；客户端永远无法指定引用名。

**泳道布局是纯函数；几何是数据。** `git-graph.ts` 移植了 VS Code 源代码管理历史图的泳道模型（MIT，见 THIRD_PARTY_NOTICES.md）：每行携带从前一行输出克隆来的 `inputSwimlanes`/`outputSwimlanes`，第一父提交替换提交自身所在泳道，额外父追加新泳道，汇聚的重复泳道在合并点收拢。第二个纯函数把单行转为精确像素的 SVG 路径/圆描述——连续竖线、S 曲线泳道左移、四分之一弧收敛、合并 `-\` 连接线，以及 HEAD 环形节点与合并双环节点——使固定 22px 的行首尾相接成一幅连续图形。`ChangesPanel` 的泳道颜色取自专用 `--dsw-specific-graph-*` token（五个轮换泳道色；当前引用把所在泳道固定为 ref 色，远端引用固定为远端色）。提交行是可展开的按钮；详情显示作者、完整哈希、时间与变更文件列表，泳道在其左侧装订区中继续流动；点击文件打开 `diff:commit:<hash>:<path>` 标签，标题带短哈希。跟踪分支出现分歧时头部显示 `↑n ↓m`。

**线上信道现在能承载该 Remote 自己的失败码。** 共享 `/api` 信封会按 `apiproxy` 的权威 `RPC_ERROR_CODES` 联合校验每个错误结果，而 workspace-file-write 的词表（`exists`、`stale-version`、`changed`、`not-text`、`mixed-eol`、`unmappable`、`too-large`、`not-found`、`not-regular`、`symlink`、`git-dir`、`path-invalid`、`workspace-unknown`、`io`）从未登记——该 Remote 的每个领域失败（包括保存冲突，属既有缺陷）都在客户端被改写成 `client api: … failed: [zod issues]`。这些码及其 details 形状现已登记进 `rpc.ts`、`RPC_ERROR_CODES` 与 `rpc.schema.ts`，既让 `exists` 可判别，也恢复了编辑器的冲突判别。

## Alternatives considered

**由编辑器插件填充 `workbench.files.actions` 槽。** 否决：这会把树入口的交互迁进编辑器包，未组合编辑器时无法新建；而 Remote 本身由 api-remotes 装配无条件挂载。inject 声明让能力留在拥有交互的树这边。

**服务端画图（宿主预计算泳道）。** 否决：泳道布局是对宿主已返回数据（`parents`、topo 序）的纯呈现计算，推到服务端会为每次呈现微调都增加线上契约。

**`git log --graph` 文本或 canvas。** 否决：文本无法按皮肤 token 给泳道上色；canvas 不能随行高拉伸，也复用不了 token 调色板。数据驱动的 SVG 让几何可以作为纯函数测试。

**为 git 历史另起一个 Typert Remote 包。** 否决：git 检视已集中在 `workspace-inspector.ts` 的一套加固 `runGit` 之后（清洗环境、10 秒期限、输出上限、Linux 上以 `/dev/fd` 为根）；把只读 git 拆到两个缝上会复制这套纪律。

**加载更多历史、树内重命名/删除、超出文件列表的提交详情视图。** 本次不做。

## Follow-up: 陈旧预览的重读

白天使用反馈：agent 改过文件后，工作台预览仍显示标签首次读取的内容——文件树刷新按钮只重列目录，会话活动重校验也只刷新列表与 Git 数据，唯独不碰已打开的标签；只有"以指定编码重新打开"会真正重读。修复将所有这些时机统一收敛到一个静默的 `rereadTab`（不闪加载态，新内容仅在读取落地时换入）：会话活动重校验、标签所在目录的 watch 变更帧（仅直接子文件）、文件树刷新按钮、以及再次点击已打开文件的树行。显式选择的编码随重读保留；有未保存修改的文档保持"已保存版本"提示不被覆盖；加载中/失败的标签与不可变的 diff 标签跳过；失败仅警告一次并保留已渲染内容。抽屉与覆盖层两个放置共享同一 store 账户，两个表面同步更新。

新增验证：组件套件逐触发器覆盖（活动防抖、watch 帧目录限定、刷新按钮、树行重点、显式编码、脏/加载中/失败跳过、二进制标签、失败警告并保留）使 `WorkspaceWorkbench.tsx` 保持逐文件 100%；e2e 增加真实宿主外部写入段落（测试进程写 `tracked.ts`、重点树行、断言新字节渲染）。

## Follow-up: 忠实 VS Code 的泳道重写

次日反馈：首版图形把每行画成独立拉伸的 SVG 段——行内边距、装订区 44px 最小高度、按纵横比拉伸成的椭圆节点，把历史拆成"火柴棍"碎片，展开详情的边框与外边距又切断泳道。重写以上述移植的泳道模型替换边模型：精确像素的 22px 行不再有纵向内边距，节点按真实半径绘制并带表面色光环（悬停时让位），单行行内容（主题、弱化作者、引用徽标；哈希与日期移入工具提示与展开详情），展开详情的左侧装订区延续泳道并强调第一父泳道，整幅图从 HEAD 到最旧提交读作一笔连续绘制。专用 `--dsw-specific-graph-*` token 取代语义别名调色板（其 brand-primary 墨色近乎纯黑）；根提交让兄弟穿过线在其下方继续流动——这是对 VS Code 在该处直接丢弃的刻意偏离。e2e 几何断言钉住契约：每个条目的 SVG 段在 0.5px 内上下铺满、条目彼此紧贴、节点圆保持正圆。

## Follow-up: 不再简化的历史取数

第三天反馈：变更页图形在 harniverse 仓库自身上画出了十余条永不汇合的平行线。问题出在取数而非绘制。`workspace.git.commits` 一直以 `git log --relative -- .` 运行，而任何路径限定都会让 `log` 启用历史简化：与侧枝树相同的 `--no-ff` 合并（合并列车里的每个 PR 合并）被丢弃，`%P` 却仍报告未改写的哈希，于是每个幸存的侧枝提交都指向窗口永远列不出的父提交，其泳道便一路延伸到底。该路径限定本就冗余：仓库校验把注册的 Workspace 根钉在工作树 toplevel 上，`.` 无论如何都指整个仓库。命令现在去掉路径限定，返回未简化的历史。验证：回归 fixture 构造两次 `--no-ff` 合并的列车，断言每个合并都在列表中、且每个列出提交的父要么在列表中要么超出窗口（对旧命令为红）；对本仓库实测取数返回 50 条提交含全部 11 个合并，泳道布局从 13 条悬空父泳道收拢为预期的两条。

## Consequences

用户不用离开树就能新建文件与文件夹（含多级路径）、一键折叠整棵树、展开任意最近提交查看它改了什么、打开该提交里单个文件的只读 diff，并一眼读出分支拓扑：泳道连线、HEAD/本地/远程/标签徽标、相对上游的领先/落后。可见 50 条窗口之外的分支不显示徽标（其提交不在列表中）；领先/落后头部覆盖了这一情形。合并提交列出的是第一父提交 diff，不是组合 diff。模型看不到这些：不改变任何提供商请求、提示词或缓存键。

已知限制。新建需要 `harniverse.operate`；无此权限的调用者能看到按钮，拒绝时透出线上消息。变更文件超过 500 个上限的提交截断并提示。图只按线性拓扑画泳道——不为窗口外的提交画列。

验证：宿主包达到 scoped 100% 行与分支覆盖（file-write 的 create/containment/faults 套件；apiproxy 的 inspector、faults、schemas、rpc-map、client-handler 与真实仓库 ApiProxy 通过，含 upstream/ahead-behind、parents/refs、合并/根提交/重命名列表、提交 diff 与 spawn 前的哈希拒绝）；客户端套件（apply 面与重挂载、工作台 store、工作台呈现含纯函数泳道算法、带回包迟到与目标重定向的创建流、提交展开、提交 diff 标签与失败、图几何渲染、创建输入框的按键与失焦所有权、AppFrame/预览的 Esc 放行）对涉及文件达到逐文件 100%；完整 GUI 单测通道（488 文件、7057 测试）；`verify-client-css-tokens`/`-classes`、变更文件的 oxlint、重复度（125 处克隆）、knip 与文档门禁。经真实组合的无密钥 web e2e：workbench 套件钉住工具条、折叠全部、徽标（HEAD、main、origin/main、v1.0.0、feature）、`↑1 ↓0` 头部、提交展开与提交 diff（golden 已刷新；带哈希的标签在捕获前关闭以保持 golden 字节稳定）；file-edit 套件就地创建 `docs/created.md` 与 `assets`、断言磁盘事实，并钉住本地化 `exists` 拒绝与 Esc 收起。未验证：新建 containment 路径在 Windows 宿主上的行为（CI 负责平台矩阵）、SVG 装订区的辅助技术行为、主题换行的提交。

PR: #188 (merge)
