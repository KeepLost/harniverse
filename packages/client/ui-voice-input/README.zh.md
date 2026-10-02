# @deepseek-ai/dsh-client-ui-voice-input

[English](README.md) | 中文

语音输入，一个纯浏览器面插件、两个席位：输入框麦克风控件（`conversation.input.left`）与「设置 → 语音输入」分区（`settings.section`）。识别本身 —— speech seam、提供方、资产与 `speech.transcribe` / `speech.prepare` Remote 方法 —— 由独立组合在宿主侧的 `@deepseek-ai/dsh-speech*` 宿主包持有。

## 麦克风控件

输入框工具行常驻的小按钮。点击开始录音（`getUserMedia` + `MediaRecorder`）；再次点击停止，经 `AudioContext` 解码，纯浏览器内下混并重采样为规范化 16 kHz 单声道 PCM16 WAV，发送 `speech.transcribe`；转写文本经作用域 `slash/input-insert-text` 事件插入草稿末尾（草稿修订 CAS 保护，未命中时提供手动插入入口）。按住设置的 `pushToTalkKey`（设置命名空间，已转小写）即按住说话 —— keydown 开始、keyup 停止并转写。

就绪引导由 locale 持有（`voice` 词典，中英）：识别器关闭（`'off'`）、麦克风权限被拒、录音 API 不支持、空转写与线上失败各自渲染专属文案，绝不静默失败。

## 设置分区

识别器选择（关闭 / SenseVoice 本机 / OpenAI 兼容云端）、语言提示、按住说话键、本机模型精度（INT8/FP32），以及只写的云端 API key（设置镜像对其脱敏；用户层出现即视为已配置）。准备按钮触发 `speech.prepare` 并在同一分区渲染已定状态 —— 就绪、未准备，或带提供方详情的失败。

## Model Experience

### 语音转写即草稿文本

#### What the model sees

`speech.transcribe` 的转写结果成为用户审阅后发送的普通输入框草稿文本；本包不新增任何提示词内容或会话事件。

#### Token effect

无；除用户选择发送的草稿文本外，本包不产生任何 token。

#### KV Cache effect

无；不改变请求前缀。

## Known Limitations and Deferred Work

- **整段采集** — 无流式转写；录制停止后第一个字节才出网。
- **仅支持草稿末尾插入** — 转写文本追加；按光标插入随上游 span CAS 工作一同推迟。
- **无波形或音量表** — 当下以录音指示与本地化状态文本承载状态。
