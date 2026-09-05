# Agent Note: 用生成的目录锁住 API 面

Status: implemented

[English](2026-09-05-api-catalog-and-ring-queues.md) | 中文

## 问题

承诺的 HTTP API 面没有已提交的机器可读清单：68 个一元方法描述符、五个载波端点、53 码错误词汇只存在于 TypeScript 类型与散落在 api 层的运行时映射中，客户端、评审与 e2e 驱动都没有可 diff 的单一产物。错误码表与 wire schema 靠人工同步（"此处一行、schema 一分支"），注册漂移只能指望 code review。另外，两条流队列——Host 的 mux/host 帧队列与客户端 WebSocket inbox——都用 `Array.shift()` 出帧，突发助手事件流下 O(n) 的弹出成为主导成本。

## 决策

加入运行时错误码注册表（`RPC_ERROR_CODES`），编译期锁死 `RpcErrorDetailsMap`（缺码即构建失败；重复或 schema 分支失配由新 spec 拦截）；用 `pnpm run gen-api-catalog` 从编译期锁定的注册表生成 `docs/api-catalog.json`，并在 `doc-sync` 内通过 `verify-api-catalog` 门禁新鲜度。把载波端点能力特例抽成 `CARRIER_ENDPOINT_CAPABILITIES`，让运行时分发与目录共享同一来源。两条 shift 队列换成环形缓冲（Host `FrameQueue` 底下是私有 `RingSlots`；客户端 `SocketRing` 为其 owning spec 导出），保持摊还 O(1) 的 push/take 与即时槽位清空。目录 spec 把已提交产物、运行时元数据与 zod 错误分支三方互锁；一次真实端到端运行（注册 → owner 批准 → mock provider 会话 → 流式回复 → `session.export` ZIP → 未认证 401）经两条重写队列压过完整表面。

## 考虑过的替代方案

**为 deque 建共享 util 包。** 否决：恰好两个持有者且分属不同 face（Host 流队列、浏览器安全的客户端 socket reader）；出现第三个消费者再抽取，且官方 `util-deque` 移植已在评审中定为延后。

**用 `satisfies` 收窄导出 zod 判别联合的分支列表。** 否决：各分支 details 输出类型无法精确满足 `RpcError`（原代码同样因此使用 cast）；改由 spec 在测试边界一次性窄化。

**采纳官方字符串式 `RemoteError` 词汇。** 否决：Harniverse 的闭合判别联合带类型化 details 严格更强；缺的只是注册表/目录纪律。

## 结果

承诺的 API 面现在有一份已提交、可机器校验并接入 CI 的产物：新增方法、能力、载波端点或错误码而未再生成目录会让 `doc-sync` 失败；运行时注册表、wire schema 与产物之间的任何漂移都会被目录 spec 拦下。两侧的流交付不再为突发流量支付平方级成本。证据：每个触碰文件聚焦覆盖 100%，`doc-sync` 29/29，`typecheck`、`oxlint`、`knip` 全净；完整单测套件绿，除七个以 root 运行时同样失败的先决 EACCES 注入用例（stash 验证过未修改 `HEAD` 上同样失败）。
