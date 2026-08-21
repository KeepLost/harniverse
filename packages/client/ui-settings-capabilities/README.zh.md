# @deepseek-ai/dsh-client-ui-settings-capabilities

[English](README.md) | 中文

Web Settings 中本地化的“Profile 组装”tab，以及只读的 Session“能力”视图。每个 target 都显示同一份带产品说明的部署配方集合；用户可暂存 `inherit`、`load` 或 `unload`，展开多成员配方选择不可修改定义的内置 Tool／Skill／MCP allowlist，并且只编辑 Persona 文本、运行时上下文策略等由 owner 声明的 Profile 安全配置字段。

修改选择、成员或配置控件时不会写入任何内容。“预览影响”把完整 draft 发送给 Host planner，并呈现显式操作及自动加入的依赖操作。“保存组装清单”只有在返回 plan 没有阻止项时才可用，提交内容仅为 plan id 与预期 revision。Session 视图显示不可变 Profile generation、配方状态以及解析后的可见／隐藏成员。

## Model Experience

无，因为本包只在浏览器中呈现和编辑 Host 所有的组装配置。

#### KV Cache effect

浏览器插件自身无影响。提交的组装可改变有效定义不同的新 Session 的可复用请求前缀。

## Known Limitations and Deferred Work

- **不修改运行中 Session** —— 编辑器面向全局默认值与 Agent Profile；Session 视图保持只读，使历史与工具调用回放绑定到同一 generation。
- **冷 Session 没有运行态结果** —— 持久化 Session 必须恢复后，Host 才能报告其进程内 generation。
