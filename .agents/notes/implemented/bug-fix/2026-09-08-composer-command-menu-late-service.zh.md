# Agent Note: 滞留于迟到 slash 服务的作曲器命令菜单按钮

Status: implemented

[English](2026-09-08-composer-command-menu-late-service.md) | 中文

## 问题

冷启动（全新标签页、无缓存 bundle）下打开 Web UI 并恢复之前的会话时，作曲器的 Commands 按钮（`toggleCommandMenu`）永久禁用：输入框可以打字、键入 `/` 仍能弹出候选菜单，但按钮永不恢复——迟到的 bundle 加载完不恢复、重渲染不恢复、切走再切回会话也不恢复。加载后新建的会话不受影响，暖重载（F5）通常掩盖该问题。

## 根因

三个事实叠加成缺陷：

1. 插槽 inject 结果按（条目 × provide 包）缓存——`web-react` 的 `runInject` 以包对象身份做记忆化，而包的身份在 provider 名册变动前保持稳定。
2. 作曲器栏的 inject 经由 hub（`rootCtx.get`）解析可选的 `inputTriggers` 服务，因此在 `ui-input-trigger` 客户端 bundle 加载之前求值的 inject 会把 `toggleCommandMenu: undefined` 固化进该缓存格。
3. 服务到达时没有任何机制使该格失效。该服务不在 session provide 名册上，名册不变就永不重新物化包；同一会话 id 切回时解析出同一包对象，过期 inject 结果被永久复用。

首次修复尝试把名册席位注册在服务构造函数里，仍然失败：vendored Cordis 的 `get` 是严格的——服务在所属 fiber 变为 `ACTIVE` 之前不可见，而构造函数运行在启动中段。席位必须在插件 fiber 激活之后注册，重解析的 inject 才能看到服务。

## 修复

`dsh-client-ui-input-trigger` 的 `apply` 在 session provide 名册上持有一个**无成员的存在性席位**，注册于其 `ctx.inject(['slots', 'inputTriggers', 'sessions'], …)` 回调内（自身 fiber 已激活、服务严格可见），随销毁撤销。席位的注册与撤销都会移动名册，重新物化所有活跃包并重发布 `currentProvideInfo`；已挂载的 session-maybe inject 缓存落空，对着此刻可见的服务重新解析。席位不贡献任何 hooks 或 props——它唯一的契约是：本服务的到来会改变其他插件 inject 的解析结果。

两个回归测试钉住两端：`apply.client.spec.ts` 断言席位在插件 fiber 生命周期内的无成员注册与撤销；`scoped-slots.client.spec.tsx` 断言渲染侧语义——当包身份轮换（名册变动的重放）时，在服务缺席时缓存的 session inject 会重跑并看到迟到的值。

## 验证

在 `master` 上用默认 home 的真实 `dsh web` 实例复现：反复冷开后按钮禁用（fiber 中 `toggleCommandMenu === undefined`，scope 存在、无 block）。修复后反复冷开按钮恢复可用并能打开命令菜单；键盘 `/` 行为不变。修复完全驻留在到达的插件里——没有给 `web-react` 或 `runtime` 增加任何消费侧缓存失效机制，插槽 inject 缓存契约（按包身份稳定）保持完整。
