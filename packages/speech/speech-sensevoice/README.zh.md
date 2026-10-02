# @deepseek-ai/dsh-speech-sensevoice

[English](README.md) | 中文

`ctx.speech` 的本机 SenseVoice 识别器提供方，注册为 `'sensevoice'`。资产按发布版本锁定并做 sha256 校验；`sherpa-onnx-node` 原生绑定（内含 ONNX Runtime）在首次转写时才懒加载。

## 资产与准备

资产位于 `$DSH_HOME/speech/sensevoice/`（`dataRoot` + `sensevoice/`）：所选精度的 SenseVoice 模型（`modelVariant` 偏好，默认 INT8）、`tokens.txt` 与 Silero VAD。每个文件按 URL 修订版本、精确字节数与 sha256 锁定（`src/assets.ts`，取自上游发布）；校验通过后提供方写入 `manifest.json` 记录接受的锁定值，`inspect` 在清单漂移时判定失败。

`prepare` 依次下载每个缺失或损坏的资产，走有序来源链 —— HEAD 探测并发竞速 `https://huggingface.co` 与 `https://hf-mirror.com`（先应答者领先；两者都保留为回退），HTTP/网络失败回落下一来源，完整性失败则中止。下载流入唯一 `.part` 文件、边流边哈希、原子发布；错误尺寸或摘要绝不落盘。重复调用会加入进行中的任务；已校验目录重新校验时不再联网。

`transcribe` 按需准备，将录音按规范化 16 kHz 单声道 PCM16 校验（`maxDurationSeconds`，默认 120），仅加载一次绑定，并在识别前用 Silero VAD 切分语音。语言：`zh`、`en`、`ja`、`ko`、`yue` 与 `auto`（默认）；其他提示立即报错。

## 配置（cordis.yml）

`dataRoot`（必填；随仓组合固定为 `!!js dshHomePath('speech')`）、`origins`（默认上述两个来源）、`probeTimeoutMs`（3 秒）、`threads`（2）、`segmentSeconds`（30）、`vadThreshold`（0.5）、`minSpeechSeconds`（0.25）、`minSilenceSeconds`（0.5）、`maxDurationSeconds`（120）。

## Model Experience

间接生效，经由 `speech.transcribe` Remote 方法与输入框麦克风控件；转写结果是普通草稿文本。

#### KV Cache effect

无；识别不进入模型请求。

## Known Limitations and Deferred Work

- **进程内推理** — 原生绑定在首次转写时于 harness 进程内加载（上游在独立 worker 进程中隔离）；原生崩溃会带倒进程。提升为 worker 形态推迟到有现场证据要求时再做。
- **首次准备下载约 227 MB（INT8）** — 该决策由「设置 → 语音输入」分区及其进度界面承担。
- **无跨进程资产锁** — 共享 `$DSH_HOME` 的两个 harness 进程可能并发下载；原子发布保证目录一致性。
