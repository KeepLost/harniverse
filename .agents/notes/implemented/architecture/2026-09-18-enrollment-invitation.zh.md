# Agent Note：Enrollment 邀请口令在认证门上兑换预签发的批准

Status: implemented

[English](2026-09-18-enrollment-invitation.md) | 中文

- 日期：2026-09-18
- 范围：`@deepseek-ai/dsh-authentication`（缝层）、`@deepseek-ai/dsh-authentication-local`（registry 与 provider）、`@deepseek-ai/dsh-auth-app`（CLI）、`@deepseek-ai/dsh-client-connection`（路由）、`@deepseek-ai/dsh-client-web`（门 UI）
- PR：待定（本 note 随功能一同提交）

## 问题

首次上手必须 owner 守在终端旁：新浏览器提交 enrollment 请求后只能等待 `dsh auth device approve`。帮手配置 kiosk 或临时借用实例一小时，要么需要主机 shell 权限，要么需要 owner 盯着待处理队列。认证门没有任何方式承载"事先已经决定"的批准。

## 决策

邀请口令是预签发的批准，不是新的认证方式。

1. **缝层把兑换归类为批准路径。** `redeemEnrollmentInvitation(id, invitation, peerAddress?)` 作为抽象服务方法与 `approveEnrollment` 并列，返回 `AuthenticationInvitationDecision`：成功时返回与批准相同的回执，失败时返回六个稳定拒绝理由之一（`invalid-invitation`、`invitation-kind`、`invitation-name`、`not-found`、`rate-limited`、`authentication-unavailable`）。
2. **Registry 把口令存进同一个 `grants.json`、同一把锁。** 记录只保存 SHA-256 `codeHash` —— `dshi1_` token 从不落盘明文 —— 外加 capability 上限、`device|temporary` kind、可选 `bindName` 和 `active|used` 状态。`redeemEnrollmentInvitation` 在一次 `mutateRegistry` 事务中标记已用并创建 Grant，成功后的重放就是 `invalid-invitation`。寿命上限 7 天，活跃口令上限 64 枚，已结算记录在 7 天审计窗口后惰性清理。
3. **限速只统计无效 token。** 兑换复用 provider 的无效凭据限速器，键为 `invitation-redeem:<peer>`，且只有 `invalid-invitation` 计数：粘贴了错误 kind 或撞名的持码者是在自我纠正，不是在攻击。kind 拒绝回传 `expected` 让 UI 能指明正确按钮；bindName 拒绝确认占用但不回显被绑定的名字。
4. **同钥待处理替换关上重试陷阱。** 浏览器在自己请求仍待处理时重新提交 enrollment（此前是对自身撞名）会在同一把锁下原子替换该待处理：新 id、新批准码、名称释放。名称冲突只剩对他钥的待处理和 Grant。
5. **CLI 负责签发、列举与吊销。** `dsh auth code issue --profile|--capability --ttl [--count] [--kind] [--bind]` 以 TSV 首列每枚 token 恰好打印一次；`code list` 只显示 id、状态和上限；`code revoke` 下线活跃口令。
6. **认证门在两个屏幕都能兑换。** enrollment 表单新增可选口令字段（容错粘贴的规范化取第一个空白分隔 token；格式错误不会发请求），待处理屏新增分隔线区块，让已在等待的请求仍可兑换。409/404 失败时「重新配对」逃生口清除已存设备身份但把密钥保留在内存，重试会用同一浏览器密钥重新 enrollment 而不是再铸一枚；轮询已批准后才到达的迟到兑换响应被 pending-id 守卫丢弃。

## 后果

- Owner 可以把有界、限时、一次性的 capability 交给帮手而无需主机权限；temporary kind 保持临时设备 60 分钟/15 分钟空闲的形态。
- 已兑换 token 的重放与未知 token 无法区分（统一 `invalid-invitation`），反复使用会触发与撞库相同的限速器。
- Registry 格式新增可选 `invitations` 列表；解析接受缺失、写入恒带，旧文件原样加载。
- `/auth/manage` 不签发口令（仅 CLI），也没有 `dsh auth device deny`；两者见下方延后项。

## 考虑过的替代方案

- **单独的口令文件：** 否决 —— 兑换必须与 Grant 创建和 owner sealing 原子；第二个文件需要自己的跨进程锁和崩溃一致性方案。
- **明文存储 token 供 CLI 再次显示：** 否决 —— token 是 bearer capability；`code list` 永远不需要它，`issue` 恰好打印一次。
- **所有兑换失败都计入限速器：** 否决 —— kind 与名称失败在门上有可操作的恢复路径；惩罚它们会把粘贴错模式的合法持码者锁死。
- **待处理请求上的限时批准码（TOTP 式）：** 延后 —— 这是批准路径上第二个与时钟耦合的机制；预签发哈希 token 以更少的活动部件覆盖同一 owner 意图场景。

## 已知限制

- 409 恢复路径中刷新页面会丢掉内存中的保留密钥（与临时凭据一样仅存内存是设计使然）；浏览器会开始全新 enrollment。
- 用于丢弃多余待处理请求的 `dsh auth device deny` 仍缺失；同钥替换只覆盖请求者自己的待处理。
