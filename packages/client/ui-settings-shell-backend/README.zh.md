# `@deepseek-ai/dsh-client-ui-settings-shell-backend`

[English](README.md) | 中文

Shell 注册表设置页:基于宿主 `shell-registry` 设置命名空间(`@deepseek-ai/dsh-shell-registry-settings`)的注册表默认单选组与自定义条目列表。写入经由绑定的 settings scope 作为 `default` 与 `entries` 字段进行;该命名空间声明 `applies: 'restart'`,应用启动桥会在下次启动时把存储的注册表解析为 `$DSH_SHELL_BACKEND`(外加自定义默认条目的可执行文件),shell 行随之重新组合。选项覆盖保留的平台拆分、两个内置项(`posix`、`pwsh`)与每条已注册自定义条目(以路径标注);显式默认在所有平台都有意义。自定义条目登记一个标识与一个可执行文件(路径或 PATH 名);条目级探测徽标来自启动时的主机描述快照,反映上一次启动的探测结果。

## 组合

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-shell-backend
  name: '@deepseek-ai/dsh-client-ui-settings-shell-backend'
```

插件注入 `slots`、`locale`、`settingsScope`。它向 `settings.section` list 槽贡献一个条目(id `shell-backend`,order 14——位于网络代理之后、插件之前:该默认决定宿主组合哪些 shell 行,因此与组合级设置为邻)。node 半边是标准的 surface no-op;偏好由 `applyShellBackendBootEnv`(`@deepseek-ai/dsh-app-boot`)在启动时消费。

## 设置页行为

- 命名空间解析完成后渲染表单;网关未暴露的命名空间显示不可用提示。
- 保存只在默认草稿与已解析值不同时写入 `default` 字段,只在条目草稿列表结构不同时写入 `entries` 字段;落定的修订会被自动采纳,草稿干净时外部修订同样被采纳。
- 保存提示会说明重启生效——不会实时切换任何东西。
- 写入被拒绝会展示服务器消息;只读身份下所有控件禁用并显示只读提示。

## Model Experience

无:该节只编辑 `shell-registry` 设置命名空间;组合的 shell 行在下次启动变化,模型请求形状不变。

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the section edits the durable preference only; the running process keeps its composed shell family until the next start (the namespace declares `applies: 'restart'`).
- **探测徽标随启动快照**——徽标反映启动时主机描述的探测结果(重启生效),不做实时再探测;表单自身不验证可执行文件能否解析。缺失的安装下次启动后经徽标暴露,此前经 shell 工具的拒绝暴露。
- **条目编辑仅为增删**——原位编辑既有条目的标识或路径等价于先删后加;slug/方言类/保留字/重复 id 规则由命名空间校验强制执行,并以拒绝写入的提示原文呈现。
