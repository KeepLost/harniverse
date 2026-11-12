# @deepseek-ai/dsh-shell-router

[English](README.md) | 中文

[`@deepseek-ai/dsh-shell`](../shell/) 执行器缝的路由 Service Provider：在隔离子作用域里**同时**挂载两个沙箱 shell 家族（[`dsh-bash-sandbox`](../bash-sandbox/)、[`dsh-pwsh-sandbox`](../pwsh-sandbox/)），并按请求的 `family` 字段（缺省时按宿主启动期解析的家族）分发每一次 `resolve`/`run`/`start`。一台宿主同时服务不同 shell 家族的会话——这是 [`dsh-session-shell`](../session-shell/) 按会话切换的基座。

包根导出 `ShellRouter`、其 `Config`（`defaultFamily`，缺省时镜像启动旗标）、`resolveDefaultFamily`、`ROUTED_FAMILY` spec 标签与 `RoutedSpec`。

## 行为

- **隔离的家族挂载，单一 settings 属主。** 两个执行器在各自子作用域（`ctx.isolate('shell')`）里注册 `ctx.shell`。家族共享 `shell` settings 命名空间，`settings.register` 遇重复即 throw，因此只有**生效默认**家族保持 settings 服务可见：其执行器在宿主级安装共享的 `shell` 节，设置卡片与热更新表现与单执行器宿主完全一致。其余家族额外隔离 `settings`，按组合项运行（见 Known Limitations）。
- **探针排序，挂载把关。** 每个可寻址 shell 经 `ctx.subprocess.resolveExecutable` 探测：两个平台内置加上每条 `shell-registry` 条目（组合携带 `shellRegistry` 服务时从中读取）。任一探测通过的 shell 所路由的家族即可挂载；探测通过者优先；探测失败只是失去优先——在什么都探不到的环境（空 PATH、最小容器）里默认家族照样未探测挂载并服务，执行失败按命令逐一暴露，与本路由器取代的单执行器宿主一致。真正决定可用性的是挂载：插件栈抛错的家族带警告降级（其子作用域被销毁），双双挂载失败才让插件加载失败关闭——路由宿主必须能服务*某种* shell。
- **按家族的组合项透传。** 路由器的 `families: { bash?, pwsh? }` 配置把各家族执行器的组合项原样交付——即退役的裸执行器行所携带的形状（`timeoutMs`、输出上限……）。生效默认家族的条目同时成为 settings 节的组合基线。
- **增量路由字段，一次物化。** `ShellExecRequest.family` 可选且增量：`dsh-tool-bash` 盖 `'bash'`，`dsh-tool-pwsh` 盖 `'pwsh'`，未打标的外来 spec 路由到生效默认家族。每个解析出的 spec 随行 `ROUTED_FAMILY` symbol 标签，`run`/`start` 分发是一次映射读取，从不重推导。调用方盖章的 `shellPath` 原样随行；发往默认家族的未盖章请求携带默认注册表条目探测解析出的绝对路径，执行器绝不重走 `PATH` 解析。`availability()` 发布默认栈与条目及每条条目的探测状态，供会话级选择器与唯一的会话解析器消费。
- **能力读取。** `availability()` 返回 `{ default, families: { bash, pwsh } }`——启动期解析的默认值与实际挂载的家族。[`dsh-session-shell`](../session-shell/) 以此做切换校验与能力面；别处的探测是结构化的（看 `availability()` 是否存在），绝不 `instanceof`。
- **默认解析**依次为配置 `defaultFamily` → `$DSH_SHELL_BACKEND` → 平台分裂（win32 为 `pwsh`，其余 `bash`）。

执行器语义（拒绝分类、沙箱事实、进程机制）原样继承自各家族执行器；本包只管路由。

```yaml
- id: shell
  name: '@deepseek-ai/dsh-shell-router'
```

## Model Experience

### 家族工具，间接

#### 模型看到什么

没有新增或改动的工具面：家族工具（`dsh-tool-bash`、`dsh-tool-pwsh`）保持各自 schema；会话能看到哪一个由 session-shell 的指针（按会话 restrict）决定，不是路由器的职责。

#### Token 影响

自身无。

#### KV Cache 影响

自身无。

## Known Limitations 与遗留工作

- **只有生效默认家族跟随运行时 settings**——另一家族按组合项运行；通过 `shell` 卡片的修改触达不到它。
- **探测只覆盖二进制存在性**——存在但起不动 profile 的 `pwsh`，要等某次 pwsh 路由调用失败才暴露；挂载探测不执行命令。
