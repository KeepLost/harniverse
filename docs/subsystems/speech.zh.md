# 语音识别

[English](speech.md) | 中文

语音缝把一段录音转成输入框文本。识别器提供方在 [`ctx.speech`](#ctxspeech--speechservice-abstract-seam) 上注册；服务校验 WAV 输入、按 `speech` 设置命名空间解析已配置的提供方并返回转写文本。本缝不接触麦克风：客户端采集音频，缝本身不携带传输。

Source: [`packages/speech/speech/src/index.ts`](../../packages/speech/speech/src/index.ts)

## 服务面

```ts type-equiv
/** One registered recognizer behind the speech seam. */
interface SpeechRecognizer {
  /** Registry id, e.g. 'sensevoice' or 'openai-compatible'. */
  id: string
}
```

服务暴露注册（`registerRecognizer`）、解析（`resolve`、`listRecognizers`）、偏好桥接（`configure`、`currentPreferences`）、资产准备（`prepare`）与转写（`transcribe`）。WAV 输入由缝统一校验——RIFF 头、PCM16 格式、参数化的时长上限——之后才交给任何提供方。

## 提供方

- **`speech-sensevoice`**——本地识别器。`<DSH_HOME>/speech/sensevoice/` 下 sha256 锁定的模型资产、有序来源探测与原子下载、`int8`/`fp32` 变体、原生绑定在首次转写时懒加载。`prepare` 下载并校验资产；`transcribe` 离线推理。
- **`speech-openai`**——面向 OpenAI 兼容 `/audio/transcriptions` 端点的云识别器，带有序链与确定性 4xx 快速失败。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeech--speechservice"></a>

### `ctx.speech` — `SpeechService`

Process-wide recognizer registry and preference holder. Load it as a plugin and it registers as `ctx.speech`; providers then register recognizers into it and `@deepseek-ai/dsh-speech-settings` pushes the user's resolved preferences. Registrations are effects: a provider's fiber disposal removes its recognizer.

```ts cordis-catalog
/**
 * Register one recognizer under its own id.
 * @param id - registry id; a duplicate registration fails loud.
 * @param recognizer - the provider implementation.
 * @returns disposer that removes the registration.
 */
registerRecognizer(id: string, recognizer: SpeechRecognizer): () => void

/**
 * List every registered recognizer.
 * @returns every registered recognizer in registration order.
 */
listRecognizers(): readonly SpeechRecognizer[]

/**
 * Look up one registered recognizer.
 * @param id - registry id.
 * @returns the recognizer, or undefined when absent.
 */
recognizer(id: string): SpeechRecognizer | undefined

/**
 * Replace the resolved preferences. The settings bridge owns this write;
 * callers read through {@link SpeechService.currentPreferences}.
 * @param preferences - the complete next resolved value.
 */
configure(preferences: SpeechPreferences): void

/**
 * Read the current resolved preferences.
 * @returns the current resolved preferences (defaults while no bridge is loaded).
 */
currentPreferences(): SpeechPreferences

/**
 * Resolve the recognizer a transcription should use.
 * @param recognizerId - explicit id overriding the preference; omitted uses it.
 * @returns the paired recognizer and language hint, or the refusal reason.
 */
resolve(recognizerId?: string): SpeechResolution

/**
 * Prepare one recognizer's local resources (download and verify).
 * @param recognizerId - explicit id overriding the preference; omitted uses it.
 * @param signal - preparation cancellation.
 * @returns the settled readiness observation, or the refusal reason.
 */
async prepare(recognizerId?: string, signal?: AbortSignal): Promise<SpeechPreparation | SpeechRefusal>

/**
 * Transcribe one recording through the resolved recognizer.
 * @param input - WAV bytes and optional language hint overriding the preference.
 * @param signal - caller cancellation.
 * @returns final text; empty when no speech was recognized.
 */
async transcribe(input: SpeechTranscribeInput, signal?: AbortSignal): Promise<SpeechTranscribeResult>
```

Source: [`packages/speech/speech/src/index.ts:53`](../../packages/speech/speech/src/index.ts)
<!-- END GENERATED cordis-surface -->

## 模型体验

语音输入由用户发起：麦克风控件与按住说话键把录音转写进输入框草稿。模型从不看到音频，只看到转写文本，因此提示词与 token 行为不变。

## 已知限制

- 本地识别器在进程内加载原生绑定；worker 进程隔离升级已推迟。
- 云转写需要已配置的 API key，缺失时快速失败。
