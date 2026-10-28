# Agent Note: 仪表盘中心合并

Status: implemented

中文 | [English](2026-10-28-dashboard-center-merge.md)

## 问题

三个同级管理界面各占一个侧边栏底部席位和一整个中心视图——定时任务（`ui-scheduler`）、远程主机（`ui-remote-hosts`），以及带选项卡的会话看板（`ui-governor`，承载本机资源与 `ui-queue` 的消息队列）。Owner 要求改为唯一的「仪表盘」入口：侧边栏只显示一个触发器，视图内呈现定时任务、远程主机、本机资源、消息队列四个平级选项卡——一次导航重设计，任何界面背后无功能变更。

## 决策

### 新外壳包持有仪表盘铬框

`dsh-client-ui-dashboard` 注册唯一的 `sidebar.footer.action` 触发器（id `dashboard-view`，order 10，排在 Cordis 面板之后）与 `center.view` 条目（id `dashboard`）。外壳即迁移并改名后的会话看板外壳：标题、返回按钮，以及走根作用域 `dashboard.center.tab` list 槽位的页内选项卡环（单贡献时环隐藏）。选项卡选择与占用事实（挂载写 `open`，触发器镜像为 `aria-pressed`）存于触发器与视图共享的一个 `createDashboardViewStore`。

### 每个领域保有自己的选项卡

`ui-scheduler` 注册定时任务 tab（id `schedules`，order 10），`ui-remote-hosts` 注册远程主机 tab（id `remote-hosts`，order 20），`ui-governor` 注册本机资源 tab（id `resources`，order 30，标签由「资源」改为「本机资源」），`ui-queue` 注册消息队列 tab（id `queue`，order 40）。选项卡注册携带自身的 `label` 与 inject 面；外壳不传任何东西，因此领域包加入或离开仪表盘无需触碰其他包——与会话看板原有缝位同一机制，如今推广到 governor 领域之外。

### 选项卡界面去掉各自的铬框与占用机制

定时任务与远程主机界面去掉外层标题、关闭按钮、占用 effect 与观看 store——三者均归仪表盘——但保留各自的领域工具栏（摘要、刷新、新建/添加）。远程主机的 `openRemote` 仍清除中心视图：切换机器仍是天然的仪表盘出口。仪表盘 tab 上挂载即激活（外壳只渲染活跃条目），原先的 `active` owner-prop 守卫随之消失。

## 后果

- 侧边栏底部保留两个条目（Cordis 面板、仪表盘）；三个领域触发器、两个观看 store、两个 sidebar-action 组件删除，`governor.center.tab` 槽位不复存在——所有注册方在同一变更中迁至 `dashboard.center.tab`。
- 仅有一个仪表盘贡献时不渲染选项卡环，裁剪后的组合仍呈现为普通界面。
- `ui-governor` 如今恰好持有本机资源 tab 与资源治理设置节；`ui-layout` 的 `center.view` 框架槽位及其切换会话即清除的语义不变。
- 默认选项卡是按 `order` 的第一个条目（如今为定时任务）；存储的选择在 id 未知时回退到它。

## 验证

- `pnpm run test:gui` 全绿（526 文件 / 7567 用例），含新 ui-dashboard 套件（插件两半、视图外壳、侧边栏触发器）与重写的 governor/scheduler/remote-hosts/queue 规范。
- 双语 README/笔记更新后 `pnpm run typecheck`、`pnpm run constraints`、`verify-package-invariants`、`verify-package-readme-model-experience`、`verify-md-wrap`、`verify-agent-note-format`、`verify-translation-pairing` 全绿。
- 经真实组合刷新 schedule-management e2e 场景与 golden 后 `DSH_SNAPSHOT=replay pnpm run test:web` 全绿（侧边栏现打开仪表盘，再进定时任务 tab）。

## 考虑过的备选方案

- **保留三个入口并加第四个承载资源/队列**:拒绝——owner 要求唯一入口;四个 footer 行也会挤爆手机轨。
- **把仪表盘外壳放进 `ui-governor`**:拒绝——定时任务与远程主机 tab 将依赖 governor 包的槽位,把无关领域耦合起来;外壳包保持依赖方向扁平(领域依赖外壳,彼此永不依赖)。
- **路由级选项卡(每 tab 一个 URL hash)**:延后——中心视图层如今不做 URL 寻址;引入路由是超出导航重设计的框架级变更。
