# @deepseek-ai/dsh-peer-outbox

[English](README.md) | 中文

实例配对的发起方结算台账:跟踪已被在线目标接受、但超出调用工具预算的委派轮次,只读轮询其结算,并把结算回复作为 plugin 来源的 user 消息投回发起会话。

台账不保存任何未投递的工作,也不做任何重试。配对是双方在线的契约:结算期不可达的目标在**同刻复探一次**后仍不可达即终态失败条目——这是 owner 的裁定,可预期的失败永远比不可预期的稍后成功安全。部署组合了本服务时,peer 工具把 running 轮次登记到此处;`dsh peer outbox` 列出台账供检视。

## Service surface

- `ctx.peerOutbox.track(input)` —— 持久登记一个已接受但仍在运行的轮次;实例重启后由下一次轮询自然恢复跟踪。
- `ctx.peerOutbox.list()` —— 全部条目,按提交时间升序。

每个轮询周期经只读 `peer/result` Remote(`harniverse.peer` 能力、`list` surface)读取每个 `watching` 条目的结算。结算的轮次在空闲维护阶段投递回复(按 `maxResultChars` 截断),来源标记为 `peer` 的 user 消息;终态条目在台账中保留结局,至多保留 200 条终态记录。失败族是闭集:`TARGET_UNREACHABLE`、`TARGET_RECORD_NOT_FOUND`、`SESSION_DROPPED`、`OWNER_SESSION_NOT_LIVE`、`READ_FAILED`。

## Configuration

- `dshHome`(必填)——持有配对目标记录与 storages 根的 Harness home。
- `pollIntervalMs`(默认 30000,最小 100)——watching 条目的轮询节奏。
- `maxResultChars`(默认 50000)——存储与投递的回复上限。

## Events

无。存储域在每次落盘写入后发出 `domain/changed`;本服务不拥有独立的事件历史。

## Verification

`packages/peer` vitest 组:单测覆盖投递、失败族、按 owner 会话的 FIFO、崩溃恢复重启、保留修剪与销毁;真 Loader 组合引导存储栈与本服务,并验证台账跨重启的持久性。

## Model Experience

### 收到结算的委派

#### 模型看到什么

peer 工具报告轮次仍在运行后,结算回复稍后以一条排队的 user 消息送达,点名目标、终态(`completed` 或 `ended <reason>`)、peer 会话 id 与截断后的回复文本。即使模型早前的轮次已被压缩,它也能在没有原始工具调用上下文的情况下处置结果。

#### Token 效应

每个结算轮次一条 user 消息;回复按 `maxResultChars` 截断,限定一次委派能给会话增加的 token 量。

#### KV Cache 效应

消息在轮次之间以普通 user 内容到达,追加在上一轮消息之后;它从不改写既有内容,缓存前缀保持有效。

## Known Limitations and Deferred Work

- 投递只面向活跃 agent:条目结算时会话已关闭或已冷,则失败为 `OWNER_SESSION_NOT_LIVE`,回复保留在台账中供 `dsh peer outbox` 查看;冷会话唤醒投递随 M6 治理工作一并处理。
- 投递与结算写入之间崩溃会为该条目重放一次投递(回复内容幂等);窗口以 flush 屏障为界。
- `dsh peer outbox` 视图从第二个进程读取持久 JSON 介质;运行中实例写入的条目在其写入完成后可见,视图永不写入。
