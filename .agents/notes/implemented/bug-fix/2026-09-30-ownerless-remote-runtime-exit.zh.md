# Agent Note: 无主远端运行时自行退出，不再孤立持有 home 租约

Status: implemented

[English](2026-09-30-ownerless-remote-runtime-exit.md) | 中文

## 问题

分离部署的远端服务器在其生命周期内持有独占 home 租约。当本地实例非正常死亡（崩溃、`SIGKILL`、机器失联）时，服务器会继续运行：它不再服务所有者，却拒绝一切后继者——新的本地实例会引导出运行中服务器从未加载的新客户端授权，其 RPC 以 `remote-hosts: REMOTE_RPC_REJECTED` 失败，而独占 home 所有权又阻止了新的 `startDetached`。该 home 会一直无法使用，直到运维手工杀死进程。真实观察到：一次对 web 栈的 `SIGKILL` 让 `/home/<user>/.dsh/server/.../node app/lib/bin.js --port 0` 存活了一天。

## 决策

所有者存活是一条由认证 RPC 流量刷新的租约，应用把租约到期转化为优雅自退出。

- `dsh-remote-runtime` 记录 `lastOwnerContact`，每个 `@Remote` 方法（`status`、`unlock`、`replaceCredentials`、`syncSettings`）都会刷新。看门狗以 `ownerlessExitMs / 5`（下限 50ms）为周期跳动；当 `Config.ownerlessExitMs`（默认 45 秒）内没有任何所有者 RPC 到达时，按饥饿周期发出一次 `remote-runtime/ownerless`。之后的所有者接触会清除本周期并重新武装下一周期——启动后未接触的服务器发一次信号，所有者到达时仍能转为有主。
- `dsh-remote-hosts` 运行会话级保活：`establish` 完成后，会话每 `heartbeatIntervalMs`（默认 10 秒）调用一次 `rpc('status')`。定时器在会话释放与 SSH 连接中止时清除。保活失败被吞掉——连接丢失检测负责失败上报。
- remote-server 应用在其 boot 回调中订阅该事件并向自身发送 `SIGTERM`，走可执行文件既有的优雅停止（树释放、端点撤除、租约释放、10 秒硬期限）。检测留在协议插件；退出动作留在应用。

退出窗口内的重连不再需要等待租约持有者消失；该缺口由同一 PR 的后续契约变更补上：远端凭据存储是当前连接协调方的镜像而非独占租约。`dsh-credentials-encrypted` 新增 `takeover(key)`——重复当前密钥为 no-op，任何其他密钥都会丢弃当前会话与存储文档，由下一次 `replace` 重建镜像——runtime 的 `unlock` Remote 现在调用它。因此崩溃协调方的后继者即使在孤儿仍存活时也能连上（已验证：`SIGKILL` 所有者后在窗口内以全新本地 home 与不同密钥重连 → connected），而上述无主退出仍会在所有所有者消失后回收进程。并发实例共享同一运行时；凭据与设置镜像反映最后建立连接的协调方。

## 曾考虑的替代方案

- **空闲 TCP 连接看门狗** — 否决：HTTP keep-alive 空档会杀死健康但空闲的会话；心跳能区分"已连接但安静"与"所有者已消失"。
- **被拒时接管** — 否决：被拒的后继者无法区分健康的外来所有者与孤儿，且凭未认证请求杀死存活服务器不可接受。
- **不分离、绑定 SSH 会话的服务器** — 否决：用现有的崩溃可恢复部署设计换拆卸正确性，得不偿失。

## 后果

本地实例崩溃后，后继者在退出窗口内直接接管凭据镜像（不同会话密钥触发重建），不再出现 `REMOTE_RPC_REJECTED`；全部所有者消失后，进程在一个退出窗口（默认 45 秒加一个看门狗周期）内自愈退出。保持连接但静默的本地实例仍在发送保活，安静会话不受影响。升级远端产物的运维将获得自愈的 home；此前已孤立的服务器仍需手工清理一次。`remote-runtime` 作用域的事件词汇表现纳入目录门禁（归属 `ssh.md`），两个包各新增经过校验的配置键。

## 验证

`remote-runtime` 单测覆盖饥饿信号、接触重武装与配置边界。协调器 spec 通过真实 fixture 驱动完整的进程内场景：保活让已连接运行时越过退出窗口仍保有主，所有者死亡（连接中止）后转为无主。真实机器 e2e（web 应用 + 真实 sshd + 重建产物）验证了确切的用户场景：连接 → `SIGKILL` web 栈 → 远端服务器约 50 秒后自行退出 → 重启的实例干净重连。
