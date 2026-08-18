# 贡献

[English](CONTRIBUTING.md) | 中文

Harniverse 欢迎问题报告、文档修正、插件实验和 PR（Pull Request）。提交 PR 是邀请维护者评审，而不是合并承诺；是否接受取决于项目范围、架构契合度、验证证据，以及维护者持续支持该结果的能力。

## 提出改动前

- 开 issue 前先搜索 [Harniverse Issues](https://github.com/KeepLost/harniverse/issues)，避免重复。重大产品、安全、分发或架构变更应先通过 issue 对齐方向，再开始实现。
- 阅读 [AGENTS.md](AGENTS.md) 了解仓库工作流与不变量，并通过 [PLUGINS.md](PLUGINS.md) 核对 DeepSeek Harness 官方基线，以及每项 Harniverse 下游能力或组合变更。
- 保持**一切皆插件**。扩展已记录的插件服务并补全 Definition（定义）、Provider（提供方）与 Consumer（消费方）角色，不要向 launcher、loop 或 bundle 添加特殊分支。
- 保留继承的 `@deepseek-ai/dsh-*` 名称与上游归属，除非经过批准的分发决策明确改变它们。

## 准备 PR

每项改动保持聚焦，并随改动提交所需测试、双语文档、生成产物与 Agent Note。设置与日常命令见[开发指南](docs/development.md)；请按 [AGENTS.md](AGENTS.md#run-relevant-checks-locally) 中的工作流选择检查，不要把一条宽泛命令当作所有表层的证明。

请描述可观察结果、重要设计边界、实际运行的命令，以及尚存的失败或环境缺口。不要包含凭据、私有端点、生成的 secret 或无关格式改动。

Harniverse 是尚无带 tag 兼容性承诺的预发布软件。贡献可以同步更新所有受影响调用方与持久化 fixture，而不添加推测性兼容代码；但必须保留显式认证、授权、TLS 和插件原生归属边界。

## 为插件生态作出贡献

插件无需进入本仓库也能发挥作用。如果某个插件的生命周期和发布节奏不属于 Harniverse，请将其作为独立插件发布，添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 以便发现，并记录它所需的 Harniverse 或上游 DSH 版本与 capability（能力）。

Harniverse 派生自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。向本仓库作出的贡献属于 Harniverse，不代表 DeepSeek AI 接受、支持或认可该改动。
