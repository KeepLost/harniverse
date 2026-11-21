# Agent Note: Peer 工件 —— 通信-only 信道上的随消息文件

Status: implemented

[English](2026-11-21-peer-artifacts.md) | 中文

## 问题

委派回合只承载文本:发起方无法把文件交给 peer 分析,peer 工作区的产物被困在生产实例上。路线图的 M7 候选把工件交换排在首位,因为其余候选——远程子 agent 描述符、workflow peer 步骤、定时委派——都以文件能移动为前提。owner 还在开工前修正了最初的设计方向:**peer 线只做通信;每一侧的配置(文件存在哪里、保留多久、上限几何)属于该侧自己的 agent。** D19 的早期草案提议在接受侧设 peer 自有的工件目录、按配对生命周期保留并由 `removePeer` 清理——这违背了该原则,已被放弃。

## 决策

工件随消息信道走;存储策略永不离开其所属侧。

- **Wire 词汇**(`dsh-peer-protocol`):`PeerUploadManifest`(名称、可选媒体类型、精确字节、base64url SHA-256)、`peer/upload` 开始交换(其结果通告接受方自己的 `maxChunkBytes` 与 `maxFileBytes`)、按绝对偏移以规范 base64 有序追加的 `peer/append` 分块、`delegate`/`followup` 请求上的 `PeerUploadRef` 条目(至多四个)、以及读回一个有界工作区文件的 `peer/download`。四个封闭理由加入词汇:`ATTACHMENT_REFUSED`、`ATTACHMENT_TOO_LARGE`、`UPLOAD_NOT_FOUND`、`DIGEST_MISMATCH`。`PeerSurface` 增加第四个布尔 `artifacts`;新配对经 `FULL_PEER_SURFACE` 授予,前工件时代的记录读回时补 `artifacts: false`(store 解析接受三或四字段面),因此既有配对保持工件关闭,直到其 owner 扩张或批准 peer 请求。
- **瞬态暂存**(`dsh-peer-host/src/staging.ts`):接受 home 下的 `.peer-uploads/<peerId>/` 承载在途分块——十五分钟 TTL、每分钟清扫、宿主启动时整体清空。槽位只有在完整字节哈希出清单摘要时才封口;不匹配则整槽丢弃。暂存是传输状态,绝非持久配置:发起方的重试故事与任何被拒调用一样,仍是同步的那一个。
- **经所属管线接纳**(`dsh-peer-host/src/delegate.ts`):投递消息的 `uploads` 以复验每个摘要、经本实例自己的 `attachments.saveFile` 提交字节来消费,并以 user 消息 `source.files` 中的持久引用加上为目标模型读取工具命名只读句柄路径的 `fileHandleText` 块投递回合——与本地用户上传完全同路。存储、保留与上限是部署既有的附件配置;peer 层一个都不拥有,工件属于接纳它们的会话——`removePeer` 清配对与治理,永不清会话工件。
- **下载**(`peer/download`):从调用者自己的 `peer-work/<instanceId>/` 根读取一个有界(十六 MiB)工作区文件,拒绝绝对与逃逸路径,发起方 `downloadPeerFile` 在使用前核验摘要。帧上限是与提示词上限同类的传输常数,不是存储策略。
- **字节预算**(`dsh-peer-host/src/governance.ts`):同一 `peer-governance.json` 条目增加可选 `monthlyBytes` 与按 UTC 周期的 `spentBytes` 桶(保留修剪与回合一致)。每个 append 的分块在任何字节落盘前授权、接受后记录;每次成功的下载投递字节在成功时记录。拒绝复用 `BUDGET_EXCEEDED`,点名周期与字节上限——没有字节计量,工件通道就是一条预算旁路。
- **发起方面**:`runPeerDelegate`/`runPeerFollowup` 接受 `files`(暂存循环遵循通告的分块上限),`downloadPeerFile` 包装反向通路;`peer` 模型工具增加 `attachFiles`(本地路径)与 `fetchFiles`(工作区相对路径,落到发起 home 的 `peer-downloads/<target>/` 下并在渲染回复中列出);CLI 增加 `run`/`send` 的 `--attach`、`fetch` 命令、`surface` 的 `--artifacts`;仪表盘预算表单同时设置两个上限(按 MiB 输入、按字节计量),旁有 artifacts 授权开关。

## 后果

- `PeerSurface` 增加第四个布尔 `artifacts`;store 解析器同时接受三字段(前工件时代,读回补 `artifacts: false`)与四字段面,因此 `peers.json` 保持版本 1,既有配对在扩张之前保持工件关闭。`peer-governance.json` 增加加性可选的 `monthlyBytes` 与 `spentBytes` 桶,保留修剪与回合一致。
- `peer` 命名空间的 typert 契约现覆盖十九个方法;工件三动词(`upload`、`append`、`download`)位于 `harniverse.peer` 之下、以面的 `artifacts` 字段门控,字节预算拒绝复用 `BUDGET_EXCEEDED`,客户端以既有封闭词汇归类。
- 暂存有意对重启不友好:宿主重启使一切在途上传失效,TTL 界定最坏孤儿。两侧都将其视为同步契约的常态——被拒或失效的传输是即时的、有归类的失败,绝不是排队的工作。
- 字节预算按接受实例计,双向合并进一个桶:送达后再取回的文件计两次,这是信道承载它的诚实成本。跨目标多点入驻的发起方各自消耗每个目标的预算,与 fabric 的按 home 配对模型一致。

## 备选方案

- **peer 自有工件目录、配对生命周期保留(被放弃的 D19 草案)**——拒绝:它让 peer 协议接管对方的数据管理。文件现在经部署自己的附件管线落地、随其会话存续;保留期遵循会话的数据策略,这正是"各侧 agent 自管配置"的要求。
- **消息体内联 base64**——拒绝:它会让持久转录、结算台账与审计视图充斥数 MB 编码文本、跳过摘要校验、并把传输大小钉死在单帧 JSON 上。分块暂存让内存有界、完整性成为结构属性。
- **方向化枚举面(`'none' | 'send' | 'receive' | 'both'`)**——拒绝:D13 的收窄语义是逐字段布尔;横向变更(`send → receive`)既非收窄也非扩张,要么强制横向挂起、要么引入新语义,都是为两个动词都由发起方驱动的现状重做刚交付的审批流。
- **peer 信道自设单件上限**——拒绝:每个接收端执行自己的附件上限并在 begin 结果中通告,发起方无需传输即可快速失败;第二个 peer 定义的上限会让信道拥有本属部署的东西。
- **定时委派并入本里程碑**——推迟为独立小 PR:M7 已横跨协议、宿主、客户端、工具、CLI 与 UI;再挂上调度接线会为零协议重叠的特性扩大爆炸半径。

## 验证

`packages/peer` 套件(205 测试):暂存生命周期(顺序、封口、摘要不匹配、TTL 清扫、重启清空、槽位上限)、治理字节(落盘前授权、接受后记录、修剪、解析臂、双上限编辑)、delegate 接纳(source.files + 句柄块、不支持/超限/原生失败的映射、artifacts 授权拒绝、字节预算落盘前拒绝、畸形引用)、Remote 级校验臂、typert 金色覆盖十九个方法及 peer/administer 能力划分;`peer-client`(工件文件 7 测试)暂存循环、畸形回读、摘要核验;`tool-peer`(20)附件投递、fetch 落地与错误映射、任何线上调用之前的不可读文件失败;`peer-app` e2e(17)经真实 Loader 组合:attach 往返(目标侧观测到字节)、follow-up attach、fetch 落入 `peer-downloads` 并核验摘要、路径逃逸拒绝、收窄后的 artifacts 拒绝;`ui-peer-admin`(21)双上限表单边界与第四授权开关。触及的 `src/` 树逐文件语句与分支覆盖 100%;type-equiv 块、cordis 目录、config 目录与模块图均已再生,1360 个翻译对全部一致。
