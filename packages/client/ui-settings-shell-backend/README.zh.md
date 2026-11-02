# `@deepseek-ai/dsh-client-ui-settings-shell-backend`

[English](README.md) | 中文

Shell 后端设置页:基于宿主 `shell-backend` 设置命名空间(`@deepseek-ai/dsh-shell-backend-settings`)的 PowerShell / Git Bash 单选表单。写入经由绑定的 settings scope 作为单个 `backend` 字段进行;该命名空间声明 `applies: 'restart'`,应用启动桥会在下次启动时把存储的偏好解析为 `$DSH_SHELL_BACKEND`,shell 工具行随之重新组合。该偏好仅在 Windows 上有意义;其他平台上仅存储而不生效。

## 组合

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-shell-backend
  name: '@deepseek-ai/dsh-client-ui-settings-shell-backend'
```

插件注入 `slots`、`locale`、`settingsScope`。它向 `settings.section` list 槽贡献一个条目(id `shell-backend`,order 14——位于网络代理之后、插件之前:该偏好决定宿主组合哪些 shell 工具行,因此与组合级设置为邻)。node 半边是标准的 surface no-op;偏好由 `applyShellBackendBootEnv`(`@deepseek-ai/dsh-app-boot`)在启动时消费。

## 设置页行为

- 命名空间解析完成后渲染表单;网关未暴露的命名空间显示不可用提示。
- 保存只在草稿与已解析偏好不同时写入 `backend` 字段,落定的修订会被自动采纳;草稿干净时外部修订同样被采纳。
- 保存提示会说明重启生效——不会实时切换任何东西。
- 写入被拒绝会展示服务器消息;只读身份下所有控件禁用并显示只读提示。

## Model Experience

None, as the section only edits the `shell-backend` settings namespace; the composed shell tool rows change on the next start, and no model request changes shape.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the section edits the durable preference only; the running process keeps its composed shell family until the next start (the namespace declares `applies: 'restart'`).
- **Git Bash availability is not probed** — selecting Git Bash does not verify Git for Windows or that `bash` resolves on PATH; a missing installation surfaces through the bash tool on the next start, not in this form.
