# `@deepseek-ai/dsh-workspace-file-write`

中文 | [English](README.md)

`ctx.workspaceFileWrite` 是工作台预览编辑占用者背后的 Host Remote：面向工作区（Workspace）作用域、要求 `harniverse.operate` 能力的文件 open/stat/save，服务用户发起的编辑。它与只读的 `workspace.files.*` 检查 API 相互独立组合——缺少本包（或浏览器侧的 `dsh-client-ui-workspace-editor` 行）时，工作台预览保持只读。

## 服务面

三个方法都以注册 Workspace 的 id 寻址（从不使用 Session），经 Typert 网关在共享 `/api` RPC 通道上暴露为 `workspaceFileWrite/open`、`/stat`、`/save`。

- **`open(workspaceId, path)`** 完整读取注册 Workspace 根内一个常规文件：≤ 1 MiB、能通过共享 codec 的有序候选链解码、单一换行风格。内容以 LF 规范化返回，附 `FsVersion` 基线与 `{encoding, encodingSource, bom, eol}` 决策。拒绝均为类型化拒绝：混合换行（`mixed-eol`）、不可解码/二进制（`not-text`）、超限（`too-large`）、路径含符号链接（`symlink`）、`.git` 路径段（`git-dir`）、越界（`path-invalid`）、缺失或非常规文件（`not-found`、`not-regular`）。
- **`stat(workspaceId, path)`** 返回文件权威的 `FsVersion` 或 `absent`。watch 推送的 change 帧版本是另一种格式，绝不可与之比较。
- **`save(workspaceId, path, { content, baseVersion, saveId })`** 经 `ctx.fs.writeText` 以 `replaceIfVersion` 写入，因此继承本地后端的按 target 锁（与 Agent 工具共享）、私有暂存、原子发布与 mode/DACL 保留。文件已被改动时以 `stale-version` 连同当前版本拒绝；原编码无法表示的字符以 `unmappable` 连同行列位置拒绝——绝不写入 `?` 字节。编码、BOM 与换行风格在 CAS 窗口内从磁盘文件重新推导（绝不采信线缆传值），并按原样写回。

`saveId` 是调用方铸造的幂等标识，弥补 Typert 路径缺失的 mutate 语义：同一 `saveId` 的重试请求回放已记录的结果而不再次写入（128 条结果的 FIFO 上界）。

## 路径规则

硬性规则全部在 Host 侧执行且刻意不可配置：注册 Workspace 根必须仍是其规范目录、请求路径必须是相对且被包含的路径、任何路径段不得为 `.git`、目标的规范形式必须等于其词法拼写（出现符号链接即拒绝）、文件必须是 1 MiB 编辑上限内的常规文件。写入额外运行在以规范 Workspace 目录为根的显式 `workspace-write` 沙箱策略下。用户保存不经 Agent 沙箱 preset 或审批——应答主体已持有 `harniverse.operate`，与 `terminal.write` 同级——且不记录 Agent 观测，因此 Agent 下一次对同一文件的守卫写入会得到 `FS_STALE_VERSION` 并必须重读。

## 事件与 Agent 提示

每次提交的保存在写入选定点发出 `workspace-file/saved { workspaceId, path, version, bytes }`。本包同时监听该事件，向 canonical cwd 等于该 Workspace 路径的每个活动会话注入一条非唤醒、仅含路径的提示（每次保存至多 32 个会话；同一会话同一路径 10 秒内至多一条）。冷会话不收到；恢复的会话在其下一次认领时看到提示。

## Model Experience

### 注入工作区会话的保存提示

#### 模型看到什么

会话收件箱中的一条用户消息（非唤醒：运行中的会话在下一个 step 边界认领，空闲会话在下一次 prompt 时认领），仅携带被编辑的路径——绝不包含内容或 diff。

##### 该字段的逐字文本

```markdown
The user saved an edit to "src/main.ts" in the workbench editor. Your earlier view of that file may be stale; read it again before editing it or relying on its earlier contents.
```

#### Token effect

条件性：每条被认领的提示约 40 token，按会话与路径在 10 秒间距窗口内合并。

#### KV Cache effect

空闲期间仅追加（提示累积到下一次认领）；被认领的提示进入下一请求的 user-message 前缀。保存本身不使任何缓存失效——只是模型此前读取的文件内容成为提示点名的陈旧事实。

## Known Limitations and Deferred Work

- **进程内锁边界** — CAS 窗口由本地后端的进程内按 target 锁保护；其他进程（`bash`、外部编辑器、`git checkout`）仍可在极小的 probe→rename 窗口内交错，与 Agent 工具承担的残余风险相同。
- **提示插件不可单独组合** — 保存提示监听器随本包发布；希望"静默保存"的组合无法在移除 Remote 的同时保留它（调研的 D6 倾向独立的 `workspace-edit-notice` 插件）。
- **远端版本错位** — 组合早于本包的远端 Host 会应答 `service-unavailable`；客户端占用者退回只读回退而不是假设两端同版本。
- **SSH 执行世界** — 工作台编辑的是 Host 本地注册目录；执行世界为 `fs-ssh` 的会话在同名路径下写的是另一个文件系统。
