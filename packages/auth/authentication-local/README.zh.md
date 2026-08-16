# dsh-authentication-local

[English](README.md) | 中文

[入站认证](../authentication/README.md)的本地具名令牌提供方。它只在 `$DSH_HOME/auth/tokens.json` 中保存令牌 lookup id 与 SHA-256 digest；`add` 和 `reset` 只返回一次生成值，而 list、诊断和访问记录只暴露非机密名称与时间戳。

## 令牌管理

```sh
dsh auth token add laptop
dsh auth token reset laptop
dsh auth token delete laptop
dsh auth token list
```

名称唯一并匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`。Reset 和 delete 只撤销对应具名令牌的浏览器会话与 WebSocket。删除最后一个令牌会封存正在运行的 authenticated 实例，但不会停止实例；新增令牌可恢复接入。Authenticated 进程不能以空 registry 启动。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Registry、日志与 lease 根目录。 |
| `mode` | `authenticated` | `authenticated` 或显式 `bypass`。 |
| `watch` | `true` | 观察令牌管理变更。 |
| `debounceMs` | `100` | Registry watcher 稳定窗口。 |
| `sessionTtlMs` | 24 小时 | 内存浏览器会话有效期。 |
| `maxBrowserSessions` | `1024` | 进程内存会话上限；达到上限时，新登录会逐出最早的有效会话。 |
| `reconcileIntervalMs` | `5000` | 文件系统 watcher 漏掉事件时的 registry 轮询后备间隔。 |
| `accessLogMaxBytes` | 10 MiB | 轮转前的活动 JSONL 大小。 |
| `accessLogMaxFiles` | `5` | 保留的轮转文件数量。 |

## 存储与生命周期

在 POSIX 上，registry 与访问文件以 `0600` 模式位于 `0700` 目录中。Registry 写入在 nonce 所有的跨进程锁下原子替换。文件系统 watch 事件触发定向撤销，周期 reconciliation 补偿漏掉的事件；authenticated 模式的 watcher 或 registry 读取失败后会拒绝新接入并关闭当前会话与 socket，直到 reconciliation 成功。Bypass 不依赖 registry freshness。进程会在 WebServer 绑定前取得 `$DSH_HOME/runtime/inbound-authentication.lease`，因此一个主目录的 authenticated 与 bypass 实例互斥；回收过期进程所有者时不会删除替代所有者的 marker。

`$DSH_HOME/auth/access.jsonl` 保存实例、令牌管理、登录与接入结果的串行轮转 JSON 记录。记录可以包含 peer 地址和令牌名称，但绝不包含请求 body、query string、Harness session id、Authorization/Cookie 值、令牌 id、digest 或浏览器会话 secret。若无法提交访问记录，一个本应成功的网络接入会改为拒绝。

## 模型体验

无，因为该提供方控制外部客户端能否访问模型相关操作，但不会改变这些操作。

#### KV Cache 影响

无；令牌与浏览器会话材料不会进入模型输入。

## 已知限制与延后工作

- 浏览器会话只存在于进程内存中，重启后必须重新登录。
- 访问记录是带大小轮转的本地 JSONL，而不是远程审计 sink。
- POSIX mode 检查在 Windows 上没有对应的 ACL 检查。
