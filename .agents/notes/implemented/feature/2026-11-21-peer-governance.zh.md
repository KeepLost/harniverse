# Agent Note:Peer 治理 —— 审批流、预算、审计与管理面

Status: implemented

[English](2026-11-21-peer-governance.md) | 中文

## Problem

配对体系把接受方留在无治理状态:能力面变更没有审批流(欠账 #7)、`peer/paired` / `peer/removed` 事件没有消费者(欠账 #8)、也没有任何东西约束配对同伴的被委派回流量。Owner 就 roadmap 的决策点拍板:D11 = c(审计作为 peers 标签页内每同伴的仅元数据会话列表;全文留在常规会话视图,保留期为配对生命周期),D13 = a 加拒绝(纯收窄立即提交;任何扩张挂起等 owner 审批;不排队;待审槽位无 TTL —— 最新请求覆盖旧请求,以无定时器的方式约束状态),D14 = b(硬预算,按已投递回合计数,月度,默认不限)。

## Decision

四个部分,各归其既有接缝:

- **Owner 治理 Remote**(`dsh-peer-host`):`list`、`remove`、`setSurface`、`approveSurface`、`rejectSurface`、`setBudget`、`audit` 加入 `peer` 命名空间,要求 `harniverse.administer` 能力 —— peer 线令牌无法触达。`list` 应答 `PeerAdminView` 行(身份、能力面、待审面、预算用量、会话数),按最新活动排序;`remove` 复用既有移除路径(结束会话、发出 `peer/removed`)并额外丢弃治理条目;`audit` 应答该同伴的会话摘要,仅元数据。
- **能力面审批流**(`dsh-peer-host` + `runPeerSurface` + `dsh peer surface`):peer 线 `surface` Remote 接收一份完整的目标能力面。纯收窄(或等价面)当场提交并顺带撤销任何已挂起请求 —— 收窄是同伴交还授权,更早挂起的扩张在更新的完整意愿收窄那一刻即告过时。含任何扩张则把整份目标面挂入记录的单一 `pendingSurface` 槽位(持久于 `peers.json`,新增可选字段;最新请求胜出,无过期时间)。请求待批期间,所有族面按现行能力面应答 —— 不排队调用、不给部分授权。发起方 CLI 打印 `committed` 或 `pending owner approval` 及仍生效的能力面。
- **回合预算**(`dsh-peer-host/src/governance.ts`):`peer-governance.json` 持有每同伴可选的月度上限,按已被接受的投递回合计数 —— `delegate` 首回合与 `followup` 回合同样计 —— UTC 自然月(`YYYY-MM`),未设置即不限,写入时修剪只留当前与上一周期。闸门在投递之前:被限额的 `delegate` 不铸造会话或工作目录,被限额的 `followup` 在会话查找之前检查,被限额的同伴无法借此探知已存 id。回合一经接受投递即计数 —— 无论其后结算如何 —— 因此并发在途投递可超出上限,至多以其自身数量为上界,README 将此记录为至多在途数的越界。拒绝以封闭原因 `BUDGET_EXCEEDED` 携带周期与限额。
- **管理消费**(`dsh-client-ui-peer-admin` + `api/remotes`):生成的 peer Remote 客户端挂入客户端装配,`peer/paired` / `peer/removed` 进入转发事件白名单,仪表盘的「配对同伴」标签页渲染名册:内联能力面开关、对挂起请求的批准/拒绝、按宿主同一 1..1000000 界的预算设置/解除、仅元数据的审计展开、带确认步的移除。注入 `hooks` 隔舱里的注册方私有 observable tick 在每个转发配对事件上重取名册 —— 这是渲染器绑定的响应事实的官方通道。

移除有意不在事件流上宣告:配对侧在下一次调用解析不到记录时发现移除,而 outbox 已把它当普通失败族处理。

## Alternatives considered

- **审计放进会话列表(D11 = a/b)** —— 拒绝:被委派会话本就作为普通会话出现在宿主会话列表里,在那里隐藏或折叠会为加一个治理视图而改变既有 UI 行为;在治理动作已经所在的 peers 标签页内放每同伴的元数据列表,给 owner 审计轨迹而不触碰工作区树。
- **待审请求 TTL** —— 拒绝:过期用一个定时器和一个新持久字段,去换单槽覆盖已经约束住的状态。挂起请求只是一个记录字段,被每个更新扩张覆盖,被任何 owner 决定或同伴收窄清除;无界队列不会形成。
- **扩张待批期间排队调用(D13 排队臂)** —— 拒绝:那会从后门重新引入 M4 已反转的语义(不可预期的迟到成功)。待批只作用于请求,从不作用于调用;拒绝保持即时、可读。
- **Token 数预算** —— 推迟:token 估算需要一个体系并不拥有的模型耦合估算器;已投递回合是精确的、今天就有,且与台账已有的计数单位一致。
- **移除时 SSE 告知帧** —— 拒绝:事件流是结算的唤醒通道;移除帧会让通道状态成为配对状态的第二权威。失败的下一次调用本就是封闭、已归类的失败。
- **按能力内省做 owner-only UI 门控** —— 拒绝:administer 能力已经门控 Remote;标签页对所有人渲染,非 owner 看到的是以本地化文案呈现的载波拒绝 —— 与 remote-hosts 标签页今天的行为一致。

## Consequences

- `PeerRecord` 新增可选字段 `pendingSurface`,存储解析器接受它(存储版本仍为 1;形状仍封闭)。`peer-governance.json` 是接受方 home 里的新 owner-only 存储。两者都记录在 peer 子系统页与宿主 README。
- `peer` 命名空间的 typert 契约现覆盖两种能力下的十六个方法;金色测试断言这一划分(线内族面为 `harniverse.peer`,治理动词为 `harniverse.administer`)。
- 事件转发白名单(`API_REMOTE_FORWARDED_EVENTS`)恰好新增两条;消费者 `ctx.remote.$on` 面自动获得它们,生产者/消费者矩阵现在显示 `apiproxy` 监听这两个事件 —— 欠账 #8 闭环。
- 预算记账按接受实例独立;发起方跨多目标各自消耗目标的预算,这与体系的身份模型(配对按 home、按方向)一致。
