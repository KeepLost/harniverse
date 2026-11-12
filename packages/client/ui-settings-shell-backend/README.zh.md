# `@deepseek-ai/dsh-client-ui-settings-shell-backend`

[English](README.md) | 中文

Shell 默认设置页:基于宿主 `shell-registry` 设置命名空间(`@deepseek-ai/dsh-shell-registry-settings`)的注册表默认单选组。写入经由绑定的 settings scope 作为单个 `default` 字段进行;该命名空间声明 `applies: 'restart'`,应用启动桥会在下次启动时把存储的注册表解析为 `$DSH_SHELL_BACKEND`(外加自定义默认条目的可执行文件),shell 行随之重新组合。选项覆盖保留的平台拆分、两个内置项(`posix`、`pwsh`)与每条已注册自定义条目(以路径标注);显式默认在所有平台都有意义。

## 组合

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-shell-backend
  name: '@deepseek-ai/dsh-client-ui-settings-shell-backend'
```

插件注入 `slots`、`locale`、`settingsScope`。它向 `settings.section` list 槽贡献一个条目(id `shell-backend`,order 14——位于网络代理之后、插件之前:该默认决定宿主组合哪些 shell 行,因此与组合级设置为邻)。node 半边是标准的 surface no-op;偏好由 `applyShellBackendBootEnv`(`@deepseek-ai/dsh-app-boot`)在启动时消费。

## 设置页行为

- 命名空间解析完成后渲染表单;网关未暴露的命名空间显示不可用提示。
- 保存只在草稿与已解析值不同时写入 `default` 字段,落定的修订会被自动采纳;草稿干净时外部修订同样被采纳。
- 保存提示会说明重启生效——不会实时切换任何东西。
- 写入被拒绝会展示服务器消息;只读身份下所有控件禁用并显示只读提示。

## Model Experience

无:该节只编辑 `shell-registry` 设置命名空间;组合的 shell 行在下次启动变化,模型请求形状不变。

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the section edits the durable preference only; the running process keeps its composed shell family until the next start (the namespace declares `applies: 'restart'`).
- **此处不探测条目可用性**——表单不验证可执行文件能否解析;缺失的安装经由下次启动的 shell 工具(及启动探测的警告)暴露,而非本表单。条目 CRUD(注册/编辑/删除自定义 shell)为后续工作:本节仅编辑默认值。
