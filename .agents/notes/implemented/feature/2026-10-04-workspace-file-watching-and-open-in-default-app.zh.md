# Agent Note:Workspace 文件监听与默认应用打开加固

Status: implemented

[English](2026-10-04-workspace-file-watching-and-open-in-default-app.md) | 中文

Scope:`packages/host/apiproxy`(`src/workspace-watcher.ts`、`src/api/workspace-files.ts`、`src/api/workspace-files.schema.ts`、`src/api/rpc.ts` + `rpc.schema.ts` + `rpc-map.ts`、`src/api-proxy.ts`、`src/fetch/client.ts`、`src/fetch/handler.ts`、`src/index.ts`、`src/workspace-inspector.ts`),`packages/client/connection`(`src/client/web-api-client.ts`、`src/client/api.ts`、`src/client/index.ts`、`src/client/fixture.ts`),`packages/api/remotes`(`src/client/index.ts`),`packages/client/runtime`(`src/client/workspaces/change-feed.ts`、`src/client/workspaces/service.ts`、`src/client/contract/workspaces.ts`、`src/client/index.ts`),`packages/client/ui-workspace`(`WorkspaceWorkbench.tsx` 的 feed 生命周期、`fileWatch` store 字段、树行与预览头的打开动作)

## Problem

蓝图行 R29(条目 X13):Harniverse 的文件树此前只能手动刷新,`host.openPath` 接受客户端发来的任意字符串。上游新增了带监听的文件 API(`workspace-files` 失效流,含父目录重锚定)与受信任栅栏保护的打开路由;其“打开方式”应用目录已被既定处置拒绝,因此 Harniverse 在自己的载体上采纳打开动作与监听 feed。

## Decision

- **监听引擎(宿主)。** 每条 `workspace-watcher.ts` 订阅恰好持有一个存活 `fs.watch`:平台支持时递归,否则向下重锚定。目标当前缺失是合法状态——观察器绑定其最近现存祖先,因此目标被创建时仍会触发;被删除的目录目标按同法重锚定(inode 替换后先重绑再 re-stat,封住丢写竞态)。原始突发按 `fileWatchDebounceMs` 窗口(默认 50 ms)折叠为单帧尾随帧;每 Workspace 并发数受 `fileWatchMaxPerWorkspace`(默认 64)限制,超限为类型化拒绝。逃逸出 Workspace 根或跨越符号链接以 `workspace-path-invalid` 拒绝,而不是监听树外。
- **载体。** 帧经既有无信封 SSE 载体传输(`GET /api/workspace.files.watch?workspaceId=&path=`),处在浏览器载体既有的认证栅栏之后(与每条 `/api` 路由同一栅栏——不复制上游独立的 `connection` 服务);能力门为 `harniverse.observe`,与一元读取一致。失败以房标 `stream/error` 信封关闭,因此客户端载体侧唯一的新代码是通用 SSE 读取器的接入:`AbstractApiClient.openWorkspaceFilesWatch` 加一个 `IApiClient.workspaceFiles.watchFiles` 成员,并在 `web-api-client` 中按 terminal 流完全相同的代系栅栏处理。
- **客户端 feed。** `ChangeFeed`(client/runtime)为每个展开的树目录持有一条订阅:`ready` 重置失败计数,`change` 调度投递目录的尾随合并 relist,流失调用连接循环同形的退避重开(带抖动上限),连续五次失败将整个 Workspace 降级为手动模式(拆除全部监听、`onMode` 一次),手动刷新按钮始终可用。类型化拒绝只安静终结自己所在的目录。运行时服务把宿主关闭帧映射为 `WorkspaceFileWatchError`(`workspace-watch-unsupported` 与 `workspace-watch-limit-reached` 都属于观察本身被拒绝;`workspace-not-found`;`workspace-path-invalid` → `outside-workspace`);其余错误保持传输层原形,交由重连路径处理。
- **打开动作。** `host.openPath` 现在对线路面设闸:只有宿主能够 stat 到的绝对路径才会打开(`bad-request` / `host-path-not-found`,两者共用一个拒绝,调用方无法借此探测具体是哪一种);宿主解析的内部打开保持原缝不变。树行与预览头暴露“以默认应用打开”,门控在已经对客户端可见的 `hostDescription.canOpenPath` 事实上(不嗅探 UA);应用目录、逐应用图标与启动器解析维持拒绝。

## Alternatives considered

**上游独立的 `connection` 信任栅栏服务。** 拒绝:浏览器载体已经对每条 `/api` 路由做认证;按路由族复制栅栏会把安全断言搬离唯一拥有它们的准入点。

**为监听流启用 WebSocket 升级。** 拒绝:既有 SSE 载体(`readSse`)已通过 fetch handler 流式传输 terminal/host/mux 帧,带认证、背压与帧模式解析;为一个新流族引入第二传输面会使载体面积翻倍。

**经一元客户端轮询。** 拒绝:轮询把删除可见性藏进节奏常数并空耗能力检查;帧流推送合并后的事实,手动模式回退为失败语义封顶。

**官方 open-in-app 应用目录与逐应用启动器。** 既定处置拒绝:`host.openPath` 的 OS 默认交接加 stat 闸已覆盖产品面,无需启动器模板、图标提取及其探测超时。

## Consequences

展开的树目录自动刷新;监听器不友好的部署在连续五次流失调用后将整个 Workspace 降级为手动刷新,而不是静默停滞。每条 watch 订阅占用该 Workspace `fileWatchMaxPerWorkspace`(默认 64)并发额度之一,病态的树展开会得到类型化拒绝而非无界观察器增长。面向线路的 `host.openPath` 在任何原生前即拒绝相对与缺失路径,调用方也无法再借打开路由探测路径存在性(共用一个拒绝)。应用目录、逐应用图标与启动器解析维持拒绝:所有打开只走操作系统默认应用。

## Verification

宿主侧:`packages/host/apiproxy/tests/workspace-file-watch.spec.ts`(15 例:帧、合并、祖先重锚、上限、释放、SSE 组帧、400 查询)、`api-proxy-workspace.spec.ts` 的 openPath 闸用例。客户端:`workspaces-change-feed.client.spec.ts`(11)、`workspaces-watch.client.spec.ts`(3 个映射用例)、`workspace-workbench.client.spec.ts` 的监听/动作测试。全树 `tsc -b` 聚合干净;按文件类型感知 lint 干净。
