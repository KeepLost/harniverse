# @deepseek-ai/dsh-client-ui-queue

[English](README.md) | 中文

消息队列面板 tab,浏览器半:经 `governor.center.tab` 槽位向会话看板中心视图注册"消息队列"tab。tab 列出 topic 的 live/archived 数、订阅数与 offset 边界;点开 topic 查看消息历史(live + 灰显的强制归档,带过期时钟)、带"休眠"徽标的订阅关系(已归档订阅者),以及受队列 Remote 能力栅约束的发布/订阅/退订控件。数据经生成的 `queue` Remote(`ctx.remote.queue`)按采样节奏轮询——与脚本、模型工具使用的同一 HTTP API 面。节点半不注册宿主行为;宿主服务位于 `@deepseek-ai/dsh-queue`。

## Composition

- 不声明槽位;贡献一个 `governor.center.tab` 条目(id `queue`,排在内置资源 tab 之后)。
- `inject`:`slots`、`locale`、`remote`、`remote.queue`。

## Model Experience

本 tab 纯展示:不发送任何模型可见输入,不读任何会话日志。模型可见行为(投递注入)属于 `dsh-queue` 服务与其工具。

## Known Limitations and Deferred Work
- 每次刷新的消息历史只取首页(100 条);分页与 offset 区间查询按需走同一 Remote 动词。
- 发布表单仅在客户端校验载荷 JSON;服务端上限仍会拒绝超限载荷。
