# @deepseek-ai/dsh-command-context

[English](README.md) | 中文

面向用户的 `/context` 斜杠命令:把只读 context-inspector 的下一请求清单(系统区段、带日志 seq 溯源的有序会话段、工具与 token 估算)渲染为 CLI 纯文本行。

## Model Experience

### 人类 `/context` 审计

#### 模型看到什么

斜杠输入与渲染清单绝不进入模型请求;命令的 `command/run`/`command/done` 对仅入日志。打印的段通过与下一请求相同的组装原语镜像其将携带的内容,每段带来源 `seq` 与被替换的 `seq`。

#### Token 效果

命令不增加任何模型 token:零输入、零输出、零辅助请求。

#### KV Cache 效果

缓存无任何变化;清单是只读投影,不改变任何界面。

## Known Limitations and Deferred Work

- **快照语义** — `/context` 打印调用时刻组装的下一请求界面;并发接受的消息可能在下一请求前落地而不出现在打印行中。
