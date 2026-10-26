# Agent Note: 已发送用户文本的凭证显示掩码

Status: implemented

[English](2026-10-26-user-text-credential-masking.md) | 中文

## Problem

把 API key 或令牌粘贴进消息的用户,等于把它分享给了之后看到屏幕或截图的每一个人:消息文本、复制文本与模型输入都带着密钥,而其中只有显示层是我们的问题。wave-5 调查把官方的 `dsh-client-ui-secret-mask`(row 7)记为吸收候选;官方的 `ui-secret-mask` 在每个已发送用户文本面上把识别出的凭证画成掩码,并带按值的显示控件。

## Decision

把官方插件移植为 `packages/client/ui-secret-mask`(owner 决策,2026-10-26),语义原样保留:掩码只改变绘制出来的样子;消息文本、复制动作与模型输入保持原始字符。

识别器(格式、表、扫描器、掩码构造)近乎逐行移植:前缀剪枝的线性扫描器、按文本记忆、匹配返回前零分配、只按格式识别(提供方 key 与令牌前缀、JWT、私钥块、地址密码)。组合方式不同,因为我们的客户端分支早于官方的 UserText 工厂与 slot 注册表:

- `dsh-client-ui-conversation` 拥有一个新的已发送用户文本缝:包内响应式模块注册表,经 `conversation` 服务面(`ctx.conversation.sentUserText`)暴露给其他插件——跨包值导入会被客户端 bundle 纯度门有意拒绝。用户气泡经 `useSyncExternalStore` 消费。
- 气泡收集已注册规则的互不重叠匹配(最早起点优先),纯文本段沿用既有的引用 chip 装饰,命中区间经规则的 `Render` 组件渲染。已发送与已准入的介入文本可交互(每个值一个眼睛控件);准入前的待定回显不可交互。
- `dsh-client-ui-secret-mask` 注册词典与一条规则,其 `Render` 即移植的 `SecretText`;随发 Web 组合挂载它,移除该行则凭证按原样绘制。

## Alternatives considered

**官方的 UserText 工厂与节点 slot。** 那套机制属于官方的 `ui-chat`/`ui-renderer` 架构,我们没有引入;为一个消费者重建它,等于给会话视图加一条平行文本管线。

**在输入框扫描并存储掩码文本。** 定义上就不可行:日志文本必须保持唯一事实,掩码只能是显示投影。

**匹配已配置密钥而非格式。** 已配置密钥清单无法知道存在哪些密钥,会诱发虚假安全感,还把客户端耦合到凭证库;格式是公开知识,且无需状态。

## Consequences

- 只掩码已发送的用户文本(助手输出、工具结果与输入框草稿按原样渲染);所属包的 README 把输入框预览记为自然的后续面。
- 性能特征得以保留并加了门:`benchmarks/user-text.bench.ts` 守住单文档预算(参考机上每 ~256 KiB 文档的中位耗时低于 1 ms),回溯式回归无法悄悄落地。
- 验证:31 项识别器测试(移植官方格式表)、组件套件(掩码/显示/交互语义)、插件注册套件、会话缝套件,以及 web-app 组合构建。
