# @deepseek-ai/dsh-client-ui-dashboard

中文 | [English](README.md)

仪表盘，浏览器半：唯一的侧边栏底部触发器打开仪表盘（仪表盘）中心视图——外壳承载标题、返回按钮，以及由 `dashboard.center.tab` 槽位贡献组成的页内选项卡环。每个管理界面都是由所属领域包自给自足贡献的选项卡（定时任务来自 `ui-scheduler`、远程主机来自 `ui-remote-hosts`、本机资源来自 `ui-governor`、消息队列来自 `ui-queue`）；仅有一个贡献时选项卡环保持隐藏。节点半不注册宿主行为。

## 组合

- 贡献一个 `sidebar.footer.action` 条目（id `dashboard-view`），其触发器经 `ctx.layout.setCenterView('dashboard')` 打开中心视图。
- 声明根作用域的 `dashboard.center.tab` 列表槽位为中心视图的 children；选项卡注册携带自身的 `order`（决定环上顺序）与 `label`（thunk 或字符串），由外壳解析。
- `inject`：`slots`、`locale`、`layout`。

## 模型体验

无：外壳仅组合其他插件的管理界面；每个选项卡的数据通路归其所属包。

#### KV 缓存影响

无；本插件既不组装也不发送提供商请求。

## 已知限制与延后工作
- 选项卡选择保存在每个浏览器会话的 store 中，不跨刷新持久化；需要时可通过 store 引擎的 `persist` 键接入。
