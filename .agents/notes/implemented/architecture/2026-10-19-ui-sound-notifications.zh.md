# Agent Note：基于补充 mux 订阅的浏览器声音通知

Status: implemented

[English](2026-10-19-ui-sound-notifications.md) | 中文

## 问题

Web GUI 没有通知音：后台标签页里回合结束、审批等待、目标受阻、任务失败全都无声，除非读者恰好看过去。社区插件 `@ai-galaxy/dsh-sound`（第三方）在原版运行时上证明了这一需求，用 localStorage 持久化、没有第一方设置通道；Harniverse 要把同样的能力做成一等公民插件——架在自己的契约上：暴露给浏览器的 `ui-sound` 设置命名空间、会话列表、帧流。

## 决策

一个浏览器侧插件包 `packages/client/ui-sound`，沿三条缝切分：

- **持久化偏好走设置命名空间**（`ui-sound`，由 Node 半体注册，并在 `dsh-host-apiproxy` 中对浏览器放行）。作用域承载总开关、静音当前会话、忽略子代理，以及两个通道各自的按类声音与音量字段。本地音频数据绝不进入文档：区块把它存进各浏览器的 IndexedDB（`dsh-ui-sound-audio`），只持久化不透明的 `audio:<id>` 引用。这用 `mcp` 打开的第一方漫游通道取代了社区插件的 localStorage 后端。
- **检测是帧级的，不是快照级的。** 检测器经 `connection.captureApi()`（钉住机器世代）为每个标签页打开一条补充 `events.mux` 订阅加 `events.host` 流，因为回合收尾需要持久的 `turn/end` 原因：aborted、blocked、`max-tokens` 与 killed 收尾必须静音，mux 打开时对仍待处理审批/提问的回放也不能在刷新时响铃。requested 帧按 `rpcId` 只响一次；`question/resolved` 重新武装其 id。提问分类优先读会话列表行落定的 `pendingInteraction`，帧形状兜底沿用 SessionManager 的计划评审规则。任务在 `running|stopping → 终态` 边沿响铃；goal 投影只在进入 `blocked` 时响。
- **播放决策是一个纯路由器。** `resolvePlayback(settings, occurrence, currentSession)` 回答是否响、响什么——总开关、子代理通道自己的字段与 `ignoreSubagent`、静音当前会话（只压当前打开会话的完成铃）。引擎负责合成（五种 Web Audio 内置音）、经同一个手势解锁 `AudioContext` 的文件播放（不受元素自动播放策略约束）、同源去重（400ms 窗口，键保留五分钟），以及 `BroadcastChannel` 上的跨标签页仲裁（单标签页直接播放；同伴按 nonce 让位，恰好一个标签页响）。

区块（id `sound`，order 75）遵循设置区块标准：四股 props、作用域经 inject `hooks` 仓绑定、写入落地前的乐观覆盖、CSS Modules 加 `--dsw-*` token 与抬升面滚动条重绑。

## 验证

- `packages/client/ui-sound/tests/watcher.client.spec.ts` 覆盖每类帧、静音规则、通道路由、burst/rpcId 纪律、重开退避与释放（23 项测试）。
- `routing`/`engine`/`cross-tab`/`audio-library`/`pick-file` 套件覆盖路由表、合成与文件路径、仲裁、IndexedDB 适配器（含 upgrade、blocked、failed、aborted 打开）与选择器生命周期。
- `apply`/`components`/`locales`/`invariant` 套件覆盖注册与 HMR 释放、区块呈现行为、词典对齐与不变量伴生件（包内共 110 项测试，per-file 100% 覆盖）。
- `ui-primitives` 新增 `IconVolumeOutline16`（图标集计数 spec 已更新）；滚动条重绑 spec 覆盖新样式表。

## 备选方案

**会话列表快照 diff（不开第二条流）。** 读运行时自己快照里的 `running` 边沿与 `pendingInteraction` 不需要额外订阅，但 `running → false` 无法区分 `completed` 与 `aborted`/`max-tokens`，用户取消会响成完成铃。社区插件恰在其兜底路径接受了这一折衷；第一方版本不接受。

**宿主侧通知信封（`dsh-notification`）。** 外发通知服务已经建模了回合收尾，但其消费者是 `ctx.notification` 上的外部后端；浏览器响铃仍需一条客户端通道，且信封词汇没有按标签页的去重键。作为绕路到浏览器已收帧的方案被否决。

**先做第一方作用域，导入桥后置。** 插件的声音词汇与社区插件一致，未来的设置导入器可以翻译 `dsh-sound:config` localStorage blob；在有人真正迁移前延后。

## 后果

- 每个浏览器标签页多持有一条 mux 订阅（在运行时自己的流之外复制帧）；受标签页数约束，重开循环指数退避。
- 本地音频文件按构造是按浏览器的；漫游机器看到被标注、不可播放的引用（包 README 已记录）。
- `ui-sound` 命名空间加入 `WEB_SETTINGS_NAMESPACES`；未来的设置导出工具免费获得该区块。
- `IconVolumeOutline16` 是原语集里第一个声音字形；后续音频相邻界面应复用它。
