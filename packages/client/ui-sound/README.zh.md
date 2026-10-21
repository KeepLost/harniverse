# `@deepseek-ai/dsh-client-ui-sound`

[English](README.md) | 中文

声音通知（Web UI）：一个设置区块加一个常驻检测器，对六类事件发出提醒——完成、审批请求、用户提问、计划评审、目标受阻、失败——每类事件有独立的声音与音量，并按主代理与子代理两个独立通道路由。每条提醒都搭载浏览器的系统通知：声音属于通知的一部分，Notifications 权限缺失或被拒时整条提醒静默，而可见且聚焦的标签页只跳过系统气泡、声音照常。Node 半体只注册一个设置命名空间；浏览器半体承载全部功能。

## 组合

```yaml
# browser row (the web-app bundle owns it)
- id: ui-sound
  name: '@deepseek-ai/dsh-client-ui-sound'
```

插件注入 `slots`、`locale`、`sessions`、`connection`、`settingsScope`。它向 `settings.section` 列表插槽贡献一个条目（id `sound`，order 75——排在外观族之后，提示类偏好为个性化分组收尾），并向 `settings.nav.icon` 键控插槽贡献导航图标（key `sound`）。Node 半体注册持久化的 `ui-sound` 设置命名空间（含默认值的 schema）；浏览器绑定该作用域，所有写入——总开关、静音当前会话、忽略子代理，以及两个通道各自的六个声音字段与六个音量字段——都经由它持久化。

## 检测

检测器经 `connection.captureApi()` 打开一条补充的 `events.mux` 订阅加 `events.host` 流（捕获的 API 把流钉在一个机器世代上；切换机器会折断流，退避循环在新世代上重开），并把帧折叠为六类事件：

- **完成** —— `reason.kind === 'completed'` 的 `turn/end`，或后台任务由 `running|stopping → completed` 收尾。
- **失败** —— `reason.kind === 'error'` 的 `turn/end`、`→ failed` 的任务，或 `host/agent-error` 帧（没有回合位置的失败不会走 mux 流）。
- **审批／提问／计划评审** —— `approval/requested` 与 `question/requested`；提问分类优先读会话列表行已落定的 `pendingInteraction`，帧形状兜底（与 SessionManager 的计划评审规则一致）。
- **目标受阻** —— `goal` 投影进入 `blocked`（重复的 blocked 值不响）。
- **契约内静音** —— aborted／blocked／`max-tokens` 回合；killed 任务；`session/subscribed`、`session/queue` 与已 resolved 帧；以及 mux 打开时回放的仍待处理请求（刷新恢复）和本页生命周期内已见过的 `rpcId`。`question/resolved` 帧会重新武装其 rpcId。
- **通道** —— 会话行标记 `origin: 'subagent'`／`parentId`，或任务 kind 为 `subagent` 时，事件路由到子代理通道。子代理声音默认静音；`ignoreSubagent` 整通道静音。

播放决策集中在一个纯函数路由器：总开关关闭时不提醒；子代理事件读自己的字段；静音当前会话只压掉当前打开会话的完成铃。

## 通知

通知器对齐 OpenCode Web 的行为：权限为 `default` 时，第一条提醒触发一次 `Notification.requestPermission()` 询问（并发提醒共享同一在途请求；被拒绝的询问按 denied 处理），只有 granted 才送达。送达时先播放提示音，随后——除非标签页可见且聚焦——弹出带本地化事件标题与会话显示标题的系统气泡；激活气泡会聚焦窗口并打开对应会话。气泡在支持的平台上声明 `silent`（提醒自带的提示音就是声音），跨标签仲裁让每次出现只在一个标签页弹气泡，与既有的单标签声音仲裁并行。

## 播放

- **内置音** —— 五种合成铃（叮咚、风铃、铃铛、完成、成功）由 Web Audio 实时生成，不随包分发音频文件。
- **本地文件** —— 区块的文件选择器把所选音频存入本浏览器的 IndexedDB（`dsh-ui-sound-audio`），设置文档里只保留不透明的 `audio:<id>` 引用，音频数据永不进入持久化文档。无法解析的引用保持选中并标注为未存储于本浏览器。
- **自动播放姿态** —— 文件音频经与内置音同一个惰性创建、经手势解锁的 `AudioContext` 解码播放，事件时点的播放不受 `HTMLAudioElement` 自动播放策略约束。一切播放失败保持静默。
- **去重** —— 同一事件的重复帧只响一次（400ms 同源窗口，键保留五分钟）；多标签页时经 `BroadcastChannel` 握手把每次事件仲裁到恰好一个标签页（单标签页直接播放，不做握手）。

## Model Experience

无：声音只在浏览器播放；本插件观察或存储的内容都不会到达模型请求。

#### KV Cache effect

无；本包既不组装也不发送供应商请求。

## Known Limitations and Deferred Work

- **本地音频文件不漫游** —— 文件存于各浏览器的 IndexedDB，设置文档同步到另一台机器后选中的 `audio:<id>` 值仍在但无法播放；区块会标注这类引用而不是替用户重选。没有导出/导入流程（内置音选择随设置文档本身漫游）。
- **每标签页一条补充 mux 订阅** —— 帧级精度（回合原因、回放抑制）的代价是每个浏览器标签页在运行时自己的流之外再开一条 mux 流；备选的快照 diff 路径无法区分完成与中止的回合。
- **提问分类与列表快照存在竞态** —— `question/requested` 帧先于会话行落定 `pendingInteraction` 到达时由帧形状兜底决定；两套规则一致，但列表行仍是权威。
- **播放失败不可见** —— 自动播放策略、不支持的编解码、已关闭的上下文、IndexedDB 缺失一律静默降级，没有任何界面；区块的试听按钮是唯一诊断手段。
- **无按工作区或免打扰时段策略** —— 总开关、静音当前会话与忽略开关就是全部门控模型；调度与按工作区路由延后。
- **权限状态在区块内无呈现** —— 通知权限被拒时提醒静默，设置区块没有横幅或重新询问按钮（浏览器自身的站点设置是恢复路径）；无用户手势的权限询问也是 Safari 有据可查的拒绝路径，首个提醒在那儿会保持静默。
