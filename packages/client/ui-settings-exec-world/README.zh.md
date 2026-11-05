# `@deepseek-ai/dsh-client-ui-settings-exec-world`

[English](README.md) | 中文

执行世界设置小节：宿主本地 / VM 世界单选对，落在宿主 `exec-world` 设置命名空间上（`@deepseek-ai/dsh-exec-world-settings`）。写入通过绑定的设置作用域作为单个 `world` 字段进行；命名空间声明 `applies: 'restart'`，因此应用引导桥把保存的偏好（连同 VM 提供者探查）解析为 `$DSH_EXEC_WORLD`，能力家族行在下一次启动重新组合；探查不健康时回退本地家族。

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-exec-world
  name: '@deepseek-ai/dsh-client-ui-settings-exec-world'
```

插件注入 `slots`、`locale` 与 `settingsScope`。它向 `settings.section` 列表插槽贡献一个条目（id `exec-world`，order 17——13–16 的组合级分组已满，世界选择器取下一个空位、位于各按 Agent 分组之前：它与邻位切换 shell 栈完全同构地切换能力家族）。节点半是标准的表面 no-op；偏好在启动时由 `applyExecWorldBootEnv`（`@deepseek-ai/dsh-app-boot`）消费。

## 小节行为

- 命名空间解析完成后表单才渲染；网关未暴露的命名空间显示不可用说明。
- 保存仅在草稿与解析偏好不同时写入 `world` 字段，结算后的修订自动采纳；草稿干净时的外部修订同样采纳。
- 已保存提示说明重启生效——不做实时切换。
- 拒绝的写入报告服务端消息；只读身份看到全部控件禁用并附只读说明。

## Model Experience

无：小节仅编辑 `exec-world` 设置命名空间；组合的能力家族在下一次启动变化，任何模型请求的形态不变。

#### KV 缓存影响

此处没有任何内容进入模型请求，提供者缓存复用不受影响。

## Known Limitations and Deferred Work

- **重启生效，非实时** — 小节仅编辑持久偏好；运行中的进程保留已组合的能力家族直到下一次启动（命名空间声明 `applies: 'restart'`）。
- **表单内不探查 VM 可用性** — 选择 VM 世界不在表单里验证 QEMU 或暂存资产；提供者不健康时在下一次启动由引导桥降级并输出一行提示。
