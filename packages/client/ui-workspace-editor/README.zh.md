# `@deepseek-ai/dsh-client-ui-workspace-editor`

中文 | [English](README.md)

工作台预览的编辑占用者：一个注册进 ui-workspace 声明的两个 `preview-document` 洞（抽屉位的 `workbench.preview.document`、overlay 位的 `shell.overlay.preview.document`）的 CodeMirror 6 编辑器。组合本包后，可编辑的预览族（code/text/markdown/html/csv/tsv）成为经 `workspaceFileWrite` Remote 手动保存的编辑器；移除该行则预览回到只读渲染，与编辑器出现之前的字节完全一致。

## 编辑模型

仅手动保存——编辑器聚焦时的 `Ctrl/Cmd+S`（快捷键不会外泄到页面）与工具栏上以文件名作为 `aria-label` 的按钮。无自动保存，无编码转换动作。编辑器展示 LF 规范化内容，保存时还原文件原有换行风格；Host 按原编码与 BOM 写回。缩进 2 空格、行号、撤销历史与自动换行遵循工作台编辑器调研的默认值。脏、保存中、冲突状态以文本呈现在 `aria-live` 区域——绝不仅靠颜色标记。

## 草稿与冲突

草稿保存在插件自有 store 中，按 机器/`workspaceId`/路径 键控：`{draft, baseVersion, eol, encoding, bom, status, conflict?}` 以及序列化的 CodeMirror 撤销历史（`EditorState.toJSON({history})`）。该账户在 overlay↔抽屉切换中存活（每次切换序列化活动编辑器状态，下一个占用者连同撤销历史一并恢复），也在机器切换中存活（注册重新绑定到新机器，而每个条目仍归属其编辑时的机器；存在未保存草稿时 `beforeunload` 守卫会警告）。保存运行独立生命周期——绝不经过工作台的请求围栏，因此切换 Workspace 不会中止在途保存——重试的保存复用 Host 侧的 `saveId` 幂等。

CAS 竞争失败（`stale-version`）或经文件级 watch 观察到的外部改动（经 `stat` 比较版本；自身保存的回声被抑制）弹出冲突条：对比修改（磁盘与草稿的统一 diff）、放弃并重新加载、或覆盖磁盘版本。不可映射字符与超限拒绝原样呈现 Host 的类型化消息。

占用者在焦点位于其内部时接管 Escape（预览的 window 捕获关闭让位）；未被占用的 Escape 请求所有者关闭，所有者在关闭脏文档前先确认。

## 依赖

CodeMirror 均为精确钉版（`state 6.7.6`、`view 6.43.13`、`commands 6.11.1`、`language 6.12.4`、`search 6.7.2`，以及最小语言集 `lang-javascript 6.2.5`、`lang-json 6.0.2`、`lang-python 6.2.1`、`lang-html 6.4.12`、`lang-css 6.3.1`、`lang-markdown 6.5.2`），并内联进本包自己的 client bundle——浏览器只在该行被组合时才会拉取这些字节，工作台关键路径不含编辑器体积。

## Model Experience

None，因为本包是浏览器侧编辑器界面；模型可见的保存提示属于 [`@deepseek-ai/dsh-workspace-file-write`](../../host/workspace-file-write/README.md)。

#### KV Cache effect

None。

## Known Limitations and Deferred Work

- **bundle 内无编辑器代码拆分** — client bundle 每插件产出单一 `client.js`，没有动态 chunk 机制；CodeMirror 字节仅随本插件的 bundle 加载，这是调研接受的懒加载结论。
- **脏草稿在确认关闭后仍保留** — 关闭脏文档会保留其草稿；重新打开该路径可恢复（未保存修改的找回）。没有显式的"关闭即丢弃"动作。
- **账户有条目上限** — 每机器至多记住 64 个条目（先开先逐出）；文件内容绝不进入浏览器持久化。
- **无 `@codemirror/merge` 并排合并** — 冲突对比为统一 diff（既有 `DiffBlock` 原语）；合并视图留待 owner 决定。
- **jsdom 几何** — 组件规格补齐了 `Range` 矩形 API；真实布局行为由组装后的浏览器构建覆盖。
