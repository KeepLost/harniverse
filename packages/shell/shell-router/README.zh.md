# @deepseek-ai/dsh-shell-router

[English](README.md) | 中文

[`@deepseek-ai/dsh-shell`](../shell/) 执行器缝的路由 Service Provider：在隔离子作用域里**同时**挂载两个沙箱 shell 家族（[`dsh-bash-sandbox`](../bash-sandbox/)、[`dsh-pwsh-sandbox`](../pwsh-sandbox/)），并按请求的 `family` 字段（缺省时按宿主启动期解析的家族）分发每一次 `resolve`/`run`/`start`。一台宿主同时服务不同 shell 家族的会话——这是 [`dsh-session-shell`](../session-shell/) 按会话切换的基座。

包根导出 `ShellRouter`、其 `Config`（`defaultFamily`，缺省时镜像启动旗标）、`resolveDefaultFamily`、`ROUTED_FAMILY` spec 标签与 `RoutedSpec`。

## 行为

- **隔离的家族挂载。** 两个执行器在各自子作用域（`ctx.isolate('shell').isolate('settings')`）里注册 `ctx.shell`。两家族共享 `shell` settings 命名空间，`settings.register` 遇重复即 throw；双重隔离把各家族的 settings 注册引向既定的无 settings 回退（组合项配置），家族之间不冲突，宿主级 `shell` 命名空间保持未注册（见 Known Limitations）。
- **先探测，后挂载。** 每个家族的二进制经 `ctx.subprocess.resolveExecutable` 探测（pwsh 家族探 `pwsh`，bash 探平台 shell）。探测失败的家族被跳过；探测通过但挂载抛错的家族带警告降级（其子作用域被销毁）；双双挂载失败会让插件加载失败关闭——路由宿主必须能服务*某种* shell。
- **增量路由字段。** `ShellExecRequest.family` 可选且增量：`dsh-tool-bash` 盖 `'bash'`，`dsh-tool-pwsh` 盖 `'pwsh'`，未打标的外来 spec 路由到生效默认家族。每个解析出的 spec 随行 `ROUTED_FAMILY` symbol 标签，`run`/`start` 分发是一次映射读取，从不重推导。
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

- **路由宿主上 `shell` settings 命名空间保持未注册**——两家族都把它隔离走了，执行器配置来自组合项而非运行时 settings。等到有第二个消费者需要运行时执行器配置时，再考虑注册一个调和的宿主级命名空间。
- **探测只覆盖二进制存在性**——存在但起不动 profile 的 `pwsh`，要等某次 pwsh 路由调用失败才暴露；挂载探测不执行命令。
