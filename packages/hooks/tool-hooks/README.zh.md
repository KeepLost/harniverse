# @deepseek-ai/dsh-tool-hooks

[English](README.md) | 中文

面向模型的工作区 hook 管理:`hook_add`、`hook_remove`、`hook_list` 让智能体在会话中途安装、移除、列出会话 hook,无需知道 hook 文件的位置或其 Claude-Code 方言格式。

hook 是一条在生命周期节点(工具调用前后、每个提交的 prompt、会话启动、回合停止边界、子代理开启/关闭)自动运行的 shell 命令,可对智能体进行门控、增强或观察:拒绝或转人工审批一次调用、注入上下文,或仅做记录。这些工具写入的是 `@deepseek-ai/dsh-hooks-claude-code` 在**每个**事件都会重新读取的项目层方言文件,因此安装或移除自下一个匹配事件起生效——会话中途、无需重载——每次 hook 运行都以 `hook/invoked` + `hook/result` 落入会话日志。

模型面不暴露方言:平实的事件名(`pre_tool`、`prompt_submit` 等)、可选的正则匹配器、命令本身,以及一个简单的 stdout 契约(`{"action":"deny"|"ask"|"allow","reason":…}`、`{"context":"文本"}`)。内部实现上,每个受管条目把真实命令存放在 `run` 字段,并把桥可见的命令指向一个生成的适配器(`tool-hooks-adapter.mjs`,写在 hook 文件旁、按内容守护)——它把事件载荷管道给命令,再把简单契约翻译成方言的 `hookSpecificOutput` 信封。同文件中的手写条目原样运行,以位置名(`pre_tool#1`)列出;每次重写都保留外来根键,写入是原子的(临时文件 + 改名)。

## 配置

```ts
import type { Config } from '@deepseek-ai/dsh-tool-hooks'
const config: Config = {
  maxHooks: 256,
}
```

## 组合

- 需要 `ctx.tools`;每次调用都需要有工作区目录的 agent 支撑会话。
- `hook_add`/`hook_remove` 为独占(重写文件);`hook_list` 并发安全。
- 由 `standard`、`cordis`、`code` 三个 agent 预设挂载(与已挂载 Claude-Code 桥的预设相同)。`maxHooks` 限制单个工作区文件保留的 hook 组总数——受管加手写——默认 256。
