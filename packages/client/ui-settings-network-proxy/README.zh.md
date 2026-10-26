# `@deepseek-ai/dsh-client-ui-settings-network-proxy`

[English](README.md) | 中文

网络代理设置页:基于宿主 `network-proxy` 设置命名空间(`@deepseek-ai/dsh-network-proxy`)的 关闭 / 系统代理 / 手动 单选表单。写入经由绑定的 settings scope 逐字段进行——mode、`url`、`noProxy`(清空的可选字段会清除其覆盖)——宿主插件把每次提交通过 `setProxyOverride` 实时解析为路由;保存不会重启任何东西。

## 组合

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-network-proxy
  name: '@deepseek-ai/dsh-client-ui-settings-network-proxy'
```

插件注入 `slots`、`locale`、`settingsScope`。它向 `settings.section` list 槽贡献一个条目(id `network-proxy`,order 13——位于全局规则之后、插件之前:该路由影响每一条出站连接,因此与连接级设置为邻)。node 半边是标准的 surface no-op;设置本身由 `@deepseek-ai/dsh-network-proxy` 宿主插件实时应用。

## 设置页行为

- 命名空间解析完成后渲染表单;网关未暴露的命名空间显示不可用提示。
- `手动` 展示地址输入对;清空的 `noProxy` 列表会清除覆盖,非 http(s) 的 `url` 会让保存保持禁用并给出内联告警(宿主本来也会告警并保持启动路由)。
- 保存只按顺序(mode、url、noProxy)写入变化的字段,落定的修订会被自动采纳;草稿干净时外部修订同样被采纳。
- 写入被拒绝会展示服务器消息;只读身份下所有控件禁用并显示只读提示。

## Model Experience

None, as the section only edits the `network-proxy` settings namespace; prompts, tools, and schemas are untouched.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **No live detection verdict** — the section edits the durable fields only; the effective route (including a warned fallback) stays in host logs until a settings view can carry read-only diagnostics.
- **Client-side URL gate duplicates the host's** — the form rejects non-http(s) URLs before the wire; the host remains the enforcer (it warns and keeps the launch route), so the two gates can drift cosmetically but never behaviorally.
