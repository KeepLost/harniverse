# dsh-error

[English](README.md) | 中文

`HarnessError` —— 所有 harness 错误共同继承的零依赖基类。它在人类可读的 `message` 之外携带稳定的、机器可路由的 `code` 与可选 `cause`,让工具结果、重试策略、UI 与回放按 code 路由,而不是解析文本。

## 它是什么

```ts
import { HarnessError } from '@deepseek-ai/dsh-error'

export class ArchiveError extends HarnessError {}

throw new ArchiveError('archive entry is missing', 'ARCHIVE_ENTRY_NOT_FOUND')
```

- `code` —— 稳定、程序化的 `UPPER_SNAKE_CASE`;路由依据永远是它,绝不解析 `message`。
- `cause` —— 标准 `ErrorOptions` 链;原始错误为诊断而保留。
- `name` —— 默认为构造子类名,并随工具结果持久化;当打包器可能重命名类时,在子类构造器中赋字符串字面量。

工具注册表只对 `instanceof HarnessError` 的失败在 `tool/result` 上记录 `{ name, code }`,因此子类只要继承此基类即加入该契约。

## 为什么零依赖

基类此前位于 `@deepseek-ai/dsh-llm`,而它在依赖图中高于 `dsh-attachment` 等包 —— 这些包为避免引用环只能重实现该形状。基类落入零依赖包后,任何包都可以继承它;`dsh-llm` re-export 同一个类,两个导入路径命名同一个类,`instanceof` 判定一致。

## 消费者

- 继承它:每个拥有包或领域一个 `*Error` 类,各自维护稳定码表(`dsh-fs` 的 `FsError`/`FS_*`、`dsh-tools` 的 `ToolArgsError`/`INVALID_ARGS`……)。
- Re-export 它:`@deepseek-ai/dsh-llm` 保持历史导入路径可用。
- 永不解析 `message` 来路由失败;按 `code` 分支。
