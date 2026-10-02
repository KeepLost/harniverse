# @deepseek-ai/dsh-speech-openai

[English](README.md) | 中文

`ctx.speech` 的 OpenAI 兼容云端识别器提供方，注册为 `'openai-compatible'`。每段录音一次 multipart `/audio/transcriptions` POST，走有序 endpoint 链。

## Endpoint 链

`endpoints`（默认 `['https://api.openai.com/v1']`；部署覆盖可按优先级追加兼容网关）逐请求遍历：传输失败（DNS、TLS、拒连）、超时与可重试状态码（408、429、5xx）回落下一 endpoint；而确定性的 4xx 应答 —— 密钥错误、请求错误 —— 立即令整条链失败，因为所有网关共享同一密钥、会重复同样语义。`model`（默认 `whisper-1`）、每 endpoint `timeoutMs`（默认 120 秒）。

API key 与默认语言来自 `speech` 设置命名空间（`apiKey` 为 `role('secret')` 字段，绝不会出现在脱敏的线上视图）。缺失密钥在任何字节出网前即以引导文案失败；`inspect` 在未设密钥时回答 `unprepared`，供设置分区引导。

## Model Experience

间接生效，经由 `speech.transcribe` Remote 方法与输入框麦克风控件；转写结果是普通草稿文本。

#### KV Cache effect

无；识别不进入模型请求。

## Known Limitations and Deferred Work

- **无流式转写** — 每段完整录音一次请求；输入框录音为整段片段。
- **整条链共用一个密钥** — 每网关凭据需要类似 llm 适配器的 credential-ref 字段；推迟到真实多网关部署提出需求。
- **无应答缓存** — 相同录音重复计费；输入框自身不会重放录音。
