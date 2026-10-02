# @deepseek-ai/dsh-speech

[English](README.md) | 中文

语音转写 Service Definition（`ctx.speech`）：识别器注册表、用户已解析偏好，以及规范化 WAV 准入校验。作为插件加载后注册为 `ctx.speech`；识别器提供方注册进来，设置桥接推送偏好。

## 契约

- `SpeechRecognizer` — 一个可替换识别器：可选 `inspect`（不下载的已定就绪观察）、可选 `prepare`（下载并 sha256 校验本地资源）、`transcribe({ wav, language? }, signal?) → { text }`。
- `SpeechService.registerRecognizer(id, recognizer)` — effect 作用域注册；重复 id 与 id 不匹配立即报错，注册 fiber 销毁即移除识别器。
- `configure(preferences)` / `currentPreferences()` — 偏好桥接由 [`@deepseek-ai/dsh-speech-settings`](../speech-settings/README.md) 持有；`resolve()` 返回配对的识别器与语言提示，否则给出拒绝原因（`disabled` / `unknown`）。
- `prepare(id?)` — 加入已解析识别器的准备任务，返回已定观察或拒绝。
- `transcribe(input, signal?)` — 按偏好解析，请求语言覆盖偏好默认值后委托执行。
- `validateWav(bytes, { sampleRate?, channels?, maxDurationSeconds })` — 规范化 PCM16 RIFF 校验（44 字节头、单一 `fmt ` 块、尺寸一致），参数化；默认值匹配提供方规范的 16 kHz 单声道。

已随仓识别器：[`@deepseek-ai/dsh-speech-sensevoice`](../speech-sensevoice/README.md)（`'sensevoice'`，本机）与 [`@deepseek-ai/dsh-speech-openai`](../speech-openai/README.md)（`'openai-compatible'`，云端）。

## Model Experience

间接生效，经由输入框麦克风控件（[`dsh-client-ui-voice-input`](../../client/ui-voice-input/README.md)）与 API 网关的 `speech.transcribe` / `speech.prepare` Remote 方法：转写结果成为普通输入框草稿文本，本包不新增任何提示词内容或会话事件。

#### KV Cache effect

无；转写不直接进入模型请求。

## Known Limitations and Deferred Work

- **单一偏好来源** — 注册表自身不持久化；未组合 `dsh-speech-settings` 的组合在桥接加载前按 `'off'` 默认值服务。
- **识别器按 id 为进程单例** — 每个上下文每个 id 一次注册，与 cordis 重复服务行为一致。
