# `@deepseek-ai/dsh-client-ui-reference`

[English](README.md) | 中文

Web `@` source 会并发请求纯路径文件候选和仅含元数据的会话候选。文件先在文件分组下显示，会话随后在会话分组下显示。带引号的 `@"path with spaces` 查询不会进入会话发现流程，两个领域的失败彼此独立降级。

文件选择插入普通 `@path` 或 `@"path with spaces"` 文本；目录选择保持菜单打开以继续深入。会话选择保留规范的 `@[label](dsh-session:...)` mention 作为原子引用身份。现有输入占位符和事务模型负责会话 occurrence 生命周期，并在提交时序列化规范 mention；本包不会读取或附加文件内容。

## Model Experience

### 文件与会话选择

#### What the model sees

文件选择变成普通路径文本，会话选择变成规范原子 mention，由 Host preparation 转换成有界的不可信快照。浏览器 source 本身不会读取或附加文件。

#### Token effect

文件选择只增加所选路径。会话选择增加规范 mention，随后由 `dsh-session-reference` 组装有界快照字节。

#### KV Cache effect

mention 是一个很小的用户消息后缀；会话快照内容在 agent pre-step 追加，不会使目标历史的更早部分失去缓存复用。

## Known Limitations and Deferred Work

- **单一全局 source**：当前 trigger registry 契约不包含按会话覆盖 source。
- **显示标签只是元数据**：文件名和会话标题不能证明内容已经被检查。
