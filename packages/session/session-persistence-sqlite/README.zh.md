# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

SQLite 持久会话存储后端：第二个 `SessionPersistence` 提供方（见[会话持久化](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)），满足与 `dsh-session-persistence-jsonl` 相同的约定（仅追加、连续 seq、延迟实体化、在 load 时关闭中断轮次），但用 `node:sqlite` 行而非文件字节表达。

`locate(meta)` 返回 `undefined`：所有会话共享一个数据库，因此不存在真实、独立的逐会话 transcript（文本记录）路径。

`readHistoryPage()` 使用索引的 `seq` 顺序查找最新 append-origin 消息候选，再读取一个连续的逻辑事件范围。即使请求范围从打包行内部开始，冷会话的倒序历史页也不需要重建完整日志。

## 存储模型

Schema 17 把普通 `SessionEvent` 存为标量行，把至少三个连续且相容的 `assistant/chunk` 文本、推理或工具调用 delta 存为打包物理行。打包保留每个逻辑事件、时间戳、序列号、分片边界和可选 surface 字段。一个物理行最多表示 1,024 个逻辑事件和 1 MiB 未压缩 UTF-8 `data`；达到 4 KiB 的 payload 仅在 Zstandard level 3 frame 更小时使用压缩。标量 `source_event_seqs` 使用无损 Varint/ZigZag 差值编码，并为有值的空列表保留独立表示。完整物理规则与理由见 [SQLite 分片行 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-22-sqlite-physical-chunk-row-compression.md)。

日志外元数据（`SessionHeader`）、每实体化 incarnation id 和每日志单调修订位于 `sessions` 行；`createdAt` 是存储在 strict `INTEGER` 列中的非负安全整数。单例状态行携带不可变存储 id。`sessions` 行只由第一次 `append` 写入，其存在性是延迟实体化信号（`list` 精确报告有行的会话）。

仓库支持的 Node 范围可不加 flag 使用 `node:sqlite`。数据库禁用 trusted schema 与内存映射 I/O、启用外键、固定 `synchronous=FULL`，并使用已配置 journal mode（默认 `wal`；WAL 共享内存文件不适用时使用 rollback mode）。`PRAGMA application_id` 标识规范持久化数据库，`PRAGMA user_version` 存储布局版本。新数据库必须没有 application identity 或用户定义 schema 对象；初始化在一个事务中创建全部表并盖上两个 pragma。非 pristine 无版本数据库、外部 application identity 和所有非当前版本在 journal-mode 变更前均会被拒绝，因为该未发布格式无迁移。

在具有 POSIX mode 的文件系统上，后端为缺失目录请求 mode `0700`，并在 SQLite 打开前以 mode `0600` 排他创建缺失数据库；进程 umask 可进一步限制两者。现有数据库文件必须是仅所有者可访问、归有效用户所有的普通文件，并且通过安全父目录而非符号链接访问。新 WAL、共享内存和持久 rollback-journal sidecar 获得数据库最终的仅所有者 mode。这些检查防止意外暴露和路径替换，但不会加密数据库。

## 行上的约定语义

- **Append = 事务。**`append` 围绕批次运行 `BEGIN IMMEDIATE`：它验证 schema 所有权、从已解码物理尾部推导下一逻辑序列、按需实体化 `sessions` 行，并插入当前批次的标量或打包行。陈旧游标或批次中失败会完全回滚，使已存储日志和内存游标保持一致。普通追加不会重写此前的打包行。
- **延迟实体化。**`create()` 只在内存记录意图，第一次 `append` 前不写行。已创建但从未 append 的会话没有 `sessions` 行，因此不在 `list()` 中（它精确报告有行的会话）。
- **在 load 时关闭中断轮次。**`load()` 实现共享[崩溃恢复约定](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)：保留有效中断轮次，在一个事务中追加合成关闭事件，并只移除撕裂物理尾部。已提交解析错误或逻辑序列缺口使会话无法加载。修复会在写锁下重新验证物理 marker，因此陈旧恢复不能删除更新的有效后缀。
- **物理行上的逻辑后缀。**`readFrom()` 与 `readHistoryPage()` 会检查可能包含请求序列的有界打包前驱，把它解码为一个逻辑范围，再只返回请求范围内的成员。
- **非修改式检查。**`inspect()` 返回不可变、平衡的逻辑视图，并可在内存中合成恢复 closer，但不会删除撕裂尾部行、追加恢复行或更改轻量修订。
- **冷删除。**`delete(id)` 以一条语句移除 `sessions` 行，外键在同一事务中级联删除其事件行。共享协调器会拒绝实时或被独占 preparation 的身份，并把删除与同 id 操作串行化。重建同一 id 会获得新的 incarnation，因此其轻量 revision 不会与已删除生命周期冲突。
- **轻量修订。**`listSnapshots(signal?)` 组合不可变存储与数据库文件身份、每实体化 incarnation id，以及在每个变更事务中递增的每会话计数器。完整前缀读取在同一个读事务中捕获该 revision 及其事件行，`readStoredRevision()` 则只查询 session 行来校验保留的 preparation。它在不解析事件行的情况下保持未变观察稳定，并区分独立存储和重建的同 id 日志。它在共享就绪和同步元数据查询前后检查取消；查询本身不可抢占。

## 配置（schemastery）

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
  busyTimeoutMs?: number   // positive integer; default 5000
  preparedSessionCacheSize?: number   // positive integer; default 5
  writeBatchMaxDelayMs?: number   // positive integer; default 200; maximum 2_147_483_647
}
```

## 写入路径

与 JSONL 后端一样，插件将每个冻结的 `session/event` 复制到对应活动会话的 controller 中，每个活动会话各有一个 controller。第一个待处理事件会开启配置的固定批处理窗口，后续事件会加入但不会重置截止时间。窗口到期后会启动一个事务；该次写入期间接纳的事件会形成另一个独立有界的后续批次。`session/flush` 会取消等待并排空当前与待处理批次。Controller 会持久化一次 fork 种子，并保留写入游标，使恢复操作绝不重新 append 已存储事件；它还会在 apply 时为活动会话设置初始状态，因为 HMR（热模块替换）不回放 `session/created`。dispose（资源释放）会在关闭数据库前排空每个保留的 controller。打包仅限每个持久批次，因此稀疏或显式 flush 的 delta 可能保持标量形式。

## 模型体验

### 恢复的对话历史

#### 模型看到的内容

SQLite 存储不会向当前请求提供提示词或 schema。加载会恢复与 JSONL 相同的呈现历史，并保留之前的 header 用于重建；新 loop 组合当前 envelope。恢复会用 `TOOL_NOT_STARTED` 平衡没有已持久化调用的 assistant 请求；已有持久化调用但无结果时则变为 `TOOL_OUTCOME_UNKNOWN`，它要求模型只重试只读或幂等工作，并验证可能的副作用或询问用户。行元数据和原始分片不会成为消息。

#### Token 影响

SQLite 存储不会增加当前请求的 token 用量。恢复会还原已保留的历史，并产生当前 envelope 以及每个中断调用所附、以引用形式呈现的修复结果文本所产生的 token 开销。

#### KV Cache 影响

SQLite 存储不修改当前请求前缀。只有重建历史、当前 envelope 和模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果会追加到末尾。

## 已知限制与暂缓事项

- **`DatabaseSync` 是同步的**：每个 append 事务在整个期间阻塞事件循环；对本地存储可接受，对繁忙多会话服务器是吞吐上限。
- **写入争用会同步阻塞**：每个连接最多等待 `busyTimeoutMs` 以取得竞争锁，`DatabaseSync` 会在等待期间阻塞其 JavaScript 线程。
- **只有 pristine 新数据库或当前自有 `SCHEMA_VERSION` 才能打开**：无版本 schema 对象、外部 application identity 和所有其他 schema 版本被拒绝，而不是迁移（未发布软件，无持久用户数据需要保留）。
- **TODO：** 该后端直接调用 `node:sqlite`。如果采用 Cordis 数据库服务（`cordis/db` / `@cordisjs` SQL driver 插件），应改为通过该服务路由，而不在此直接持有 `DatabaseSync`；约定接口（`SessionPersistence`）不会变，只更换存储驱动。
