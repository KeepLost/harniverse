# speech/ — 语音输入能力族

[English](README.md) | 中文

该能力族把麦克风录音变成输入框文本：一个识别器 seam、两个随仓识别器（本机 SenseVoice 与 OpenAI 兼容云端链）、一个设置命名空间，以及一个浏览器面（输入框麦克风与其设置分区）。

| 包 | 角色 | ctx key |
|---|---|---|
| [`speech/`](speech/README.md) | 定义识别器注册表、偏好与 WAV 准入校验 | `ctx.speech` |
| [`speech-sensevoice/`](speech-sensevoice/README.md) | 本机 SenseVoice 提供方：锁定 sha256 的资产、有序来源回退、懒加载原生绑定 | 注册于 `ctx.speech` |
| [`speech-openai/`](speech-openai/README.md) | 走有序 endpoint 链的 OpenAI 兼容云端提供方 | 注册于 `ctx.speech` |
| [`speech-settings/`](speech-settings/README.md) | 持久化 `speech` 设置命名空间并桥接进注册表 | 注册于 `ctx.settings` |

浏览器半边位于 [`client/ui-voice-input`](../client/ui-voice-input/README.md)；Remote 面（`speech.transcribe`、`speech.prepare`，能力 `harniverse.operate`）位于 API 网关。吸收决策与验证记录见[语音输入 Agent Note](../../.agents/notes/implemented/feature/2026-10-03-voice-input.md)。
