# Agent Note: 压缩优先会话历史

Status: implemented

[English](2026-08-22-compaction-first-session-history.md) | 中文

## 问题

普通冷 Session 在客户端发布消息前会串联三项成本：倒序页面为满足普通消息配额可能越过最近一次压缩检查点，已结算 Assistant chunk 会反复重放进定稿文本，Host 还会在返回页面前恢复整份日志的投影。因此，大型已压缩日志会让模型最直接的上下文窗口排在已被替代的原始历史和派生状态工作之后。

## 决策

普通 Session 的初始 `session.history` 请求使用 `projectionMode: 'omit'`。其脱离 Session 的历史页优先采用最近一次 compact 插件 replacement 检查点事务，并返回其后的全部原始事件，即使该窗口超过普通的 50 条消息配额。页面从事务起点到持久尾部保持连续；`hasMore` 与既有排他 `beforeSeq` 分页继续提供对全部旧事件的访问。没有检查点的初始页面和所有更早页面继续遵守普通 append 消息配额。检查点搜索本身也以同一单位设限：在配额之外最多再扫描 `CHECKPOINT_SEARCH_MESSAGE_BUDGET` 条 append-origin 消息，之后返回普通配额页。每个后端都在自己的读取方式中执行该上限，因此没有压缩的会话只读取其尾部。按地址访问的 subagent 保留原有历史协议。

`replacementCheckpointStart()` 识别 source 来自 compact 插件的 replacement `user/message`。压缩把第一项 provenance 保留给 `compaction/start`，第二项保留给 `compaction/summary`，其余项才是被遮蔽的 surface 节点，因此该 helper 直接使用第一项引用 seq 作为连续事务起点。它不会把 `surfaceOp.end` 当作原始日志截断水位线；区域 replacement 可能保留当前更早节点，先前 replacement 也可能让 surface 位置的 seq 不再单调。

Host 的默认历史响应保持向后兼容，仍组合事件和投影。`projectionMode: 'omit'` 跳过投影恢复；`projectionMode: 'only'` 拒绝分页字段，返回空事件和权威投影基线。脱离 Session 的仅投影读取通过轻量元数据解析不可变 header，确保常驻 Profile scope，再直接读取投影缓存或执行一次完整 inspect 回退；它不会先读取一页随后丢弃的历史。客户端先安装并发布事件窗口，再通过浏览器空闲时间调度投影恢复，非 DOM 环境使用任务回退。后台投影失败不影响打开状态；独立 epoch 与 `AbortController` 会在重新建基、断连、移除、重连和缺口修复之间阻止陈旧响应发布。缺口会同步取消排队中或进行中的恢复，并在修复后只调度一次新基线。Fetch carrier 会把取消信号转发到 Host 元数据、持久化、缓存和 inspect 工作。

批量历史仍传输并保留全部 Event 和 Match。Chat 与 Trajectory Definition 只能跳过各自已定稿 Assistant chunk 的 State transition，同时保留首 token 计时、usage、自定义 Definition 访问、中断流和实时 append。

## 考虑过的替代方案

**从 wire 删除已结算 chunk 或被替代历史。** 拒绝：插件 Definition 将收到与持久化不同的 Event 窗口，原始 seq 连续性会改变，更早历史也无法通过既有分页器恢复。

**在 `surfaceOp.end + 1` 截断。** 拒绝：replacement 范围使用 surface 位置，而非安全的原始日志前缀水位线。区域压缩与工具结果 replacement 都可能保留 seq 更早或不单调的当前节点。

**在点击响应中等待投影。** 拒绝：冷投影缓存或陈旧缓存可能从 seq 零开始恢复。派生值不是发布消息窗口的前提，可以在独立 generation 栅栏下刷新。

**新增专用投影 endpoint。** 拒绝：既有授权历史路由已经拥有 Session 身份、常驻 Profile 组合、活动快照、冷缓存恢复和传输校验。两个请求模式无需创建另一条能力路径即可保留这些所有权。

## 后果

首个可见窗口是最直接解释模型压缩后上下文的精确连续日志区间，同时全部持久历史仍可访问。当窗口从压缩标记开始时，Chat 会抑制自动边界预取，由读者明确点击“加载更早内容”来决定何时让被替代历史进入浏览器；普通窗口保留原有预取。依赖投影的 UI 可以在消息出现后再结算，并在重连或帧缺口修复后最终恢复权威状态。检查点后的上下文异常大时会有意超过普通展示页配额；Definition 自有的已结算 chunk 回放策略限制其浏览器重建成本。

JSONL 没有独立检查点索引，因此必须向后搜索以发现最近检查点，并在有界搜索窗口耗尽后停止解码记录；SQLite 用同一窗口推导 seq 下界，只查询该下界之上的 replacement 行。两个后端都不改变持久格式。

无界搜索是本决策绝不允许回退到的形态。最初的实现在搜索期间丢掉了配额停止条件，于是每个没有压缩的会话在每次点击标题时都会反向解码整个产物：在一份 203,000 事件的 Zstandard 日志上，产出同一页面却实测 16.7 秒，而非 0.28 秒，30 秒的一元历史超时把它变成读者看到的请求中止。有界窗口把该代价保持在 0.27 秒，同时仍能找到相关检查点。API 只增加可选模式，省略它们的调用方继续获得组合响应。

## 验证

共享持久化约定覆盖原始 JSONL、Zstandard JSONL 和 SQLite：检查点被普通消息配额遮住、无检查点时有界回退、以及更早页面恢复。一个边界用例从两侧固定每个后端的上限：位于窗口外一条消息处的检查点必须不影响普通配额页，而窗口内的检查点仍必须切分页面。去掉共享分页器、JSONL 解码器或 SQLite seq 下界中的任一上限，该用例都会失败。另有一个 Zstandard 用例监视帧解压缩，证明优先页只解码尾部帧。一个客户端测试把首屏请求固定为不带 `AbortSignal`，因此后台投影取消不可能中止消息窗口。Host API 与 schema 套件覆盖默认、omit、only、非法模式组合、缓存命中时零页面恢复，以及取消冷 inspect。客户端 Session 测试覆盖先发布后投影、失败、重连、重新建基、取消，以及延迟陈旧基线与缺口修复的竞态；Chat 测试证明压缩边界只能手动预取，而普通预取继续生效。浏览器性能通道生成 500 轮、压缩到第 496 轮，并让尾部 24 轮各保留恰好 400 个 Assistant text delta；它断言压缩后 1,600 个 delta 和恰好四轮，不发自动 `beforeSeq` 请求，把投影恢复合并为实时修复后的一次 `only` 请求，并实测从点击标题到消息可见为 712.7 ms，限制为三秒。
