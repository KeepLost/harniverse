# Agent Note: 滞留于迟到 slash 服务的作曲器命令菜单按钮

Status: implemented

[English](2026-09-08-composer-command-menu-late-service.md) | 中文

## 问题

冷启动（全新标签页、无缓存 bundle）下打开 Web UI 并恢复之前的会话时，作曲器的 Commands 按钮（`toggleCommandMenu`）永久禁用：输入框可以打字、键入 `/` 仍能弹出候选菜单，但按钮永不恢复——迟到的 bundle 加载完不恢复、重渲染不恢复、切走再切回会话也不恢复。加载后新建的会话不受影响，暖重载（F5）通常掩盖该问题。

三个事实叠加成缺陷。插槽 inject 结果按（条目 × provide 包）缓存：`web-react` 的 `runInject` 以包对象身份做记忆化，而包的身份在 session provider 名册变动前保持稳定。作曲器栏的 inject 经由 hub（`rootCtx.get`）解析可选的 `inputTriggers` 服务，因此在 `ui-input-trigger` 客户端 bundle 加载之前求值的 inject 会把 `toggleCommandMenu: undefined` 固化进该缓存格。而服务到达时没有任何机制使该格失效：该服务不在 session provide 名册上，名册不变就永不重新物化包——同一会话 id 切回时解析出同一包对象，过期的 inject 结果被永久复用。恢复表面的 e2e golden 一直在忠实记录这个缺陷（重载后 `button "Commands" [disabled]`）。

## 决策

启动器从此是一个插槽：`dsh-client-ui-conversation` 的作曲器条目声明第三个命名控制席位 `conversation.input.commands`（single、session 作用域——与其旁的 plan/model 席位完全同形），由 `dsh-client-ui-input-trigger` 的 `CommandSeat`（加号按钮）填充。栏侧的 owner 份额是它的禁用状态、它的输入框焦点保持器、以及一个点击时取上下文的回调（`captureContext`，捕获选区端点、leading/inline 位置、草稿版本号与弹层关闭）；条目的 inject 面持有切换逻辑，经由自己的会话控制器瞄准一次合成的 `'/'` 命中（`toggleSource('command', …)`），并把控制器的 launcher store 经 hooks 间室暴露给 `aria-expanded`。SlotMap 合并与上下文/injected 类型住在 `ui-input-trigger`（与 `conversation.input.overlay` 相同的依赖方向拆分：owner 包依赖注册方，绝不反向），运行时声明留在作曲器的 children 表里。`toggleCommandMenu` 成员从 `ComposerBarInjected` 移除，作曲器 inject 不再为该按钮供料。

插件缺席时席位不渲染任何内容，因此 `ui-input-trigger` 迟到激活时按钮经由插槽系统自身的生命周期自然出现——`slots.inject` 本就等待声明、坍缩即移除、重声明即重跑、随插件 fiber 离开。在场即可用性信号；禁用状态收敛为单独的 `locked`。

## 考虑过的备选方案

- **session provide 名册上的无成员存在性席位**（在插件的 `ctx.inject` 回调里 `sessions.provide({ resolve: () => ({}) })`）。实现过、验证过能修复按钮，随后撤销：运行中注册席位是系统有史以来第一次运行时名册变更，它会重新物化所有活跃会话包，重跑全应用所有缓存的 session inject。CI 上十二个浏览器回放场景失败（候选卡在加载、作曲器草稿丢失、快照漂移、路由夹具被双重满足）——消费者从未在 inject 重跑下被演练过，而名册"启动期一次性追加"的假设是承重的。渲染侧契约（名册变更 → 包身份轮换 → inject 重解析）仍由一个 `web-react` 回归测试钉住，但没有已发布的插件在运行时改变名册。
- **点击时惰性解析**——保留按钮，在点击处理器内用严格 `ctx.get` 解析服务。否决：点击会生效，但渲染出的禁用状态是对同一滞留缓存的渲染期读取；修复它需要一个反应式可用性 observable，而 cordis 没有原生的服务到达事件来喂它。
- **让 `ui-input-trigger` 急切加载**而非 bootstrap 延迟。否决：只是收窄竞争窗口而没有消除它，且拿冷启动成本换正确性。

## 后果

在 `master` 上用默认 home 的真实 `dsh web` 实例复现：反复冷开后按钮禁用（fiber 中 `toggleCommandMenu === undefined`，scope 存在、无 block）。改为插槽席位后，反复冷开——包括恢复旧会话——都渲染出可用并能打开命令菜单的按钮；键盘 `/` 行为不变，恢复表面的 golden 现在记录的是已启用的启动器。作曲器的 `menuLauncher` 钩子仍读取 inject 时捕获的控制器 store，因此它仅存的消费者（`canSteerQueue` 的占位符优先级）在服务晚于 inject 到达时可能持有过期关闭值——有界的装饰性过期，在此记录而非扩大。对任何"其交互面需要被其他表面感知"的迟到插件，模式从此是：通过你自己的插槽条目贡献 UI，让在场成为信号。
