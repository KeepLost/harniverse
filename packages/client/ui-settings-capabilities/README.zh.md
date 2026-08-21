# @deepseek-ai/dsh-client-ui-settings-capabilities

[English](README.md) | 中文

Web Settings 中本地化的“Profile 组装”tab，以及只读的 Session“能力”视图。Settings tab 仅在挂载后读取 Agent Profile roster 与授权 capability-management Remote。每个 target 都显示同一份部署配方集合；用户可为 Tool、Skill、MCP-server 与 Subagent-provider entry 暂存 `inherit`、`load` 或 `unload` 值。Profile 行会显示其继承的全局有效选择。

修改选择控件时不会写入任何内容。“预览影响”把完整 draft 发送给 Host planner，并呈现显式操作及自动加入的依赖操作。“保存组装清单”只有在返回 plan 没有阻止项时才可用，提交内容仅为 plan id 与预期 revision。Session 视图显示不可变 Profile generation，以及每项配方的已加载、未加载、加载失败、依赖阻止或安全拒绝结果。

## Model Experience

无，因为本包只在浏览器中呈现和编辑 Host 所有的组装配置。

#### KV Cache effect

浏览器插件自身无影响。提交的组装可改变有效定义不同的新 Session 的可复用请求前缀。

## Known Limitations and Deferred Work

- **不修改运行中 Session** —— 编辑器面向全局默认值与 Agent Profile；Session 视图保持只读，使历史与工具调用回放绑定到同一 generation。
- **冷 Session 没有运行态结果** —— 持久化 Session 必须恢复后，Host 才能报告其进程内 generation。
