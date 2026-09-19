# @deepseek-ai/dsh-execution-descriptor

[English](README.md) | 中文

不可变执行世界描述符契约。Agent Profile 指向远端执行机器之前，该机器先发布自描述——身份、传输方式、POSIX workspace 根、能力清单、支持的远端 preset、机器自有配置立场、凭据引用和单调 revision——并由规范 JSON 的 sha256 digest 封签。解析（`parseExecutionWorldDescriptor`）校验每个字段、重算 digest，并返回深度冻结的描述符；`buildExecutionWorldDescriptor` 是计算 digest 的发布侧助手。

契约拒绝远端执行永远不应携带的内容：不是执行世界内绝对 POSIX 路径的 `workspaceRoot`（从不序列化 host 本地路径）、不是 `machine` 的 `configOwner`（执行的机器拥有支配执行的 MCP/Skill/Hook 配置；发现结果回传宿主）、执行词汇表之外的能力 kind、不是 POSIX 环境变量名的凭据引用（值从不传输）、以及 `LOCAL_ONLY_PRESET_IDS` 中列出的任何 preset——`cordis` preset 编辑 live Cordis 组合，是宿主管理能力，绝不是远端执行能力。

本包只提供契约。通过传输发布描述符、与已固定 Profile 权限对账、以及针对它执行的 SSH provider，由组合本包的运行时完成。

## Model Experience

### 执行世界描述符

#### 模型看到什么

描述符报告的能力清单作为模型所指向执行世界的工具和技能呈现；描述符本身是模型从不读取的元数据。

#### Token 效应

无直接影响——来自已报告能力的工具 schema 与本地一样加入请求。

#### KV Cache 效应

无——描述符改变组装哪些能力，不改变请求历史。

## Known Limitations and Deferred Work

- 描述符发布、传输固定、revision 轮换、以及与运行中 Session 已捕获 capability generation 的对账，属于 SSH 执行 provider。
- 描述符以 digest 封签完整性、不以签名；部署需要来源证明时，由认证传输或带外签名包裹它。
