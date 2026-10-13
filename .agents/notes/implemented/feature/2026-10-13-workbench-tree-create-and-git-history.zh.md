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

**泳道布局是纯函数；几何是数据。** `git-graph.ts` 为窗口内每个提交分配泳道（第一父提交延续节点泳道，额外父提交在节点旁新开一条并右移穿过线，汇聚的泳道在合并点收拢，空出的槽位会被复用），并产出每行的连接线几何（`upper`、`lower`、`through`；直线或三次曲线）与按哈希稳定的调色板索引。`ChangesPanel` 把每行左侧的装订区渲染为可拉伸的内联 SVG，颜色取自七个别名 token，因此一条分支线跨刷新保持同色，皮肤也能重调配色。提交行是可展开的按钮；详情显示作者、完整哈希、时间与变更文件列表；点击文件打开 `diff:commit:<hash>:<path>` 标签，标题带短哈希。跟踪分支出现分歧时头部显示 `↑n ↓m`。

**线上信道现在能承载该 Remote 自己的失败码。** 共享 `/api` 信封会按 `apiproxy` 的权威 `RPC_ERROR_CODES` 联合校验每个错误结果，而 workspace-file-write 的词表（`exists`、`stale-version`、`changed`、`not-text`、`mixed-eol`、`unmappable`、`too-large`、`not-found`、`not-regular`、`symlink`、`git-dir`、`path-invalid`、`workspace-unknown`、`io`）从未登记——该 Remote 的每个领域失败（包括保存冲突，属既有缺陷）都在客户端被改写成 `client api: … failed: [zod issues]`。这些码及其 details 形状现已登记进 `rpc.ts`、`RPC_ERROR_CODES` 与 `rpc.schema.ts`，既让 `exists` 可判别，也恢复了编辑器的冲突判别。

## Alternatives considered

**由编辑器插件填充 `workbench.files.actions` 槽。** 否决：这会把树入口的交互迁进编辑器包，未组合编辑器时无法新建；而 Remote 本身由 api-remotes 装配无条件挂载。inject 声明让能力留在拥有交互的树这边。

**服务端画图（宿主预计算泳道）。** 否决：泳道布局是对宿主已返回数据（`parents`、topo 序）的纯呈现计算，推到服务端会为每次呈现微调都增加线上契约。

**`git log --graph` 文本或 canvas。** 否决：文本无法按皮肤 token 给泳道上色；canvas 不能随行高拉伸，也复用不了 token 调色板。数据驱动的 SVG 让几何可以作为纯函数测试。

**为 git 历史另起一个 Typert Remote 包。** 否决：git 检视已集中在 `workspace-inspector.ts` 的一套加固 `runGit` 之后（清洗环境、10 秒期限、输出上限、Linux 上以 `/dev/fd` 为根）；把只读 git 拆到两个缝上会复制这套纪律。

**加载更多历史、树内重命名/删除、超出文件列表的提交详情视图。** 本次不做。

## Consequences

用户不用离开树就能新建文件与文件夹（含多级路径）、一键折叠整棵树、展开任意最近提交查看它改了什么、打开该提交里单个文件的只读 diff，并一眼读出分支拓扑：泳道连线、HEAD/本地/远程/标签徽标、相对上游的领先/落后。可见 50 条窗口之外的分支不显示徽标（其提交不在列表中）；领先/落后头部覆盖了这一情形。合并提交列出的是第一父提交 diff，不是组合 diff。模型看不到这些：不改变任何提供商请求、提示词或缓存键。

已知限制。新建需要 `harniverse.operate`；无此权限的调用者能看到按钮，拒绝时透出线上消息。变更文件超过 500 个上限的提交截断并提示。图只按线性拓扑画泳道——不为窗口外的提交画列。

验证：宿主包达到 scoped 100% 行与分支覆盖（file-write 的 create/containment/faults 套件；apiproxy 的 inspector、faults、schemas、rpc-map、client-handler 与真实仓库 ApiProxy 通过，含 upstream/ahead-behind、parents/refs、合并/根提交/重命名列表、提交 diff 与 spawn 前的哈希拒绝）；客户端套件（apply 面与重挂载、工作台 store、工作台呈现含纯函数泳道算法、带回包迟到与目标重定向的创建流、提交展开、提交 diff 标签与失败、图几何渲染、创建输入框的按键与失焦所有权、AppFrame/预览的 Esc 放行）对涉及文件达到逐文件 100%；完整 GUI 单测通道（488 文件、7057 测试）；`verify-client-css-tokens`/`-classes`、变更文件的 oxlint、重复度（125 处克隆）、knip 与文档门禁。经真实组合的无密钥 web e2e：workbench 套件钉住工具条、折叠全部、徽标（HEAD、main、origin/main、v1.0.0、feature）、`↑1 ↓0` 头部、提交展开与提交 diff（golden 已刷新；带哈希的标签在捕获前关闭以保持 golden 字节稳定）；file-edit 套件就地创建 `docs/created.md` 与 `assets`、断言磁盘事实，并钉住本地化 `exists` 拒绝与 Esc 收起。未验证：新建 containment 路径在 Windows 宿主上的行为（CI 负责平台矩阵）、SVG 装订区的辅助技术行为、主题换行的提交。

PR: #TBD (merge)
