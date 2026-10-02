# Agent Note：语音输入 —— speech seam、本机 SenseVoice、云端链、输入框麦克风

Status: implemented

English | [中文](2026-10-03-voice-input.md)

范围：`packages/speech/*`、`packages/host/apiproxy`、`packages/client/ui-voice-input`、`packages/bundle/base`、`packages/bundle/web-app`、`apps/desktop`

## 问题

UPSTREAM-ABSORPTION-REVIEW.md 的 X15 行：Harniverse 此前没有语音输入。上游 harness 带有一套实验性语音栈（`api-speech-to-text`、`speech-to-text`、`speech-to-text-sensevoice`、`client-ui-voice-input`），构建在其 typert Remote 协议与 worker 进程运行时之上 —— 这些都无法按原样吸收进 Harniverse 的 apiproxy/组合模型。

## 决策

- **speech seam 作为 Service Definition**（`@deepseek-ai/dsh-speech`，`ctx.speech`）。一个具体注册表服务持有 `registerRecognizer(id, recognizer)`（effect 作用域，重复 id 立即报错）、由设置桥接推送的已解析偏好、回答配对识别器或 `disabled`/`unknown` 拒绝的 `resolve()`，以及其上的 `prepare`/`transcribe`。`SpeechRecognizer` 契约保持本任务给定的最小面 —— `transcribe({ wav: Uint8Array; language?: string }, signal?) → { text: string }` —— 外加可选的 `inspect`/`prepare` 就绪观察。规范化 WAV 准入校验从 seam 包导出并参数化（`sampleRate`/`channels` 默认 16 kHz 单声道、`maxDurationSeconds`），取代上游的固定常量。
- **本机 SenseVoice 提供方**（`@deepseek-ai/dsh-speech-sensevoice`）。资产锁定值逐字取自上游发布（模型 int8/fp32、tokens、Silero VAD：URL、精确字节、sha256）落在 `src/assets.ts`。资产位于 `$DSH_HOME/speech/sensevoice/`，并写入记录所接受锁定值的 `manifest.json`；`inspect` 在文件或清单漂移时判定失败。下载流入唯一 `.part` 文件、边流边哈希、原子发布；有序来源链对 `https://huggingface.co` 与 `https://hf-mirror.com` 并发 HEAD 探测并保留下载回退；HTTP/网络失败回落下一来源，完整性失败中止。`fetch` 可注入供测试。`sherpa-onnx-node` 绑定（锁定 1.13.8，内含 ONNX Runtime）在首次 `transcribe` 时懒加载 —— 准备阶段绝不加载原生代码。
- **对上游的偏离：进程内推理。** 上游在受管 worker 进程中隔离绑定；Harniverse 在进程内加载（懒 require），因为 X15 决策行只点名懒绑定，且子进程 seam 不属于本批次。已记录为该包的首要已知限制；提升推迟到有现场证据要求时。
- **OpenAI 兼容云端提供方**（`@deepseek-ai/dsh-speech-openai`）。上游没有，链在此设计：`endpoints`（官方 `api.openai.com/v1` 在先；覆盖层追加网关）逐请求遍历 —— 传输失败、超时与 408/429/5xx 回落；确定性 4xx 立即使整条链失败（共享密钥 ⇒ 语义重复）。API key 与语言来自设置命名空间；缺密钥在任何字节出网前即失败。
- **设置命名空间持久化**（`@deepseek-ai/dsh-speech-settings`）。`speech` 命名空间（`applies: 'live'`，组合 `base`）持有 `recognizer`（默认 `'off'`）、`language`、`pushToTalkKey`、`modelVariant`（默认 `'int8'`）与 `apiKey`（`role('secret')`，所有线上视图脱敏）。注册即把已解析值推入 `ctx.speech`，`scope.watch` 跟随每次提交 —— 桥接随插件 fiber 存续。
- **带 Harniverse 能力的 Remote**（apiproxy）。`speech.transcribe`（`{ wavBase64, language? } → { text }`，`harniverse.operate`，mutate）在 seam 见到音频前校验规范化 base64、4 MiB 字节上限与 `validateWav(…, 120s)`；拒绝映射为 `speech-unavailable`（seam 缺席 / 选择关闭 / 未知 id）与 `speech-transcription-failed`。`speech.prepare`（`{} → SpeechPrepareView`，`harniverse.operate`，mutate）加入已解析识别器的准备并回答已定观察。线上注册完全沿用 X05 `jobs.follow` 链：`api/speech.ts` + `api/speech.schema.ts` + 两行 `RpcMethodMap` + fetch handler 路由 + `IApiClient.speech` + 进程内 fixture 分发。`'speech'` 加入 `WEB_SETTINGS_NAMESPACES`，设置面得以访问命名空间。
- **输入框麦克风与设置分区**（`@deepseek-ai/dsh-client-ui-voice-input`，一个包持有两个席位）。麦克风按钮位于 `conversation.input.left`：点击录音（getUserMedia + MediaRecorder），再次点击停止并在浏览器内完成重编码（AudioContext 解码 → 下混 → 线性重采样 → 规范化 PCM16 WAV）后发送 `speech.transcribe`；转写文本经带草稿修订 CAS 的作用域 `slash/input-insert-text` 事件插入（未命中时提供手动插入）。按住说话按住已配置键。未就绪引导由 locale 持有（中英）：识别器关闭、权限被拒、录音不支持、空转写。「设置 → 语音输入」分区（一个 `settings.section` 条目）经共享设置 scope 编辑命名空间，并以已定状态驱动 `speech.prepare`。
- **Desktop 主窗麦克风权限。** 原先全拒的 `setPermissionRequestHandler`/`setPermissionCheckHandler` 现在仅在窗口显示已连接 Host 的 loopback Web origin 时授予 `'media'`；渲染器 shell 与其他 origin 依旧拒绝。`build.mac.extendInfo` 加入 `NSMicrophoneUsageDescription`。Windows 桌面应用麦克风访问无需清单条目。
- **随仓组合。** base bundle 挂载 `speech`、`speech-settings`、`speech-sensevoice`（`dataRoot: !!js dshHomePath('speech')`）与 `speech-openai`；web-app bundle 挂载 `ui-voice-input` 及其三个注册面（tsconfig.client.json 引用、`dsh.client` 行、bundle 依赖）。
- **三方声明。** `sherpa-onnx-node`（Apache-2.0）经清单进入运行时表；生成器新增「Downloaded model assets」小节，披露锁定的 SenseVoice 发布（Apache-2.0）、Silero VAD（MIT）与内置 ONNX Runtime（MIT）。

## 备选方案

- 吸收上游 typert `SpeechController` Remote：否决 —— Harniverse remote 是 `harniverse.*` 能力下的 apiproxy RPC 行；并行 Remote 协议会绕过认证契约。
- 按识别器各建一个设置提供方：否决 —— 带 `'off'` 的单一命名空间把选择、云端密钥与按住说话放进一份现有设置 UI 已镜像的热重载文档。
- 录音直接以 webm/opus 上行：否决 —— seam 契约与宿主校验只承认一种规范形态（16 kHz 单声道 PCM16 WAV），浏览器自己承担转码。

## 后果

语音输入是插件原生能力：seam、两个提供方、偏好桥接与浏览器席位各自独立装卸，线上面像所有业务路由一样声明 `harniverse.operate` 能力。首次本机使用向 `$DSH_HOME/speech/sensevoice` 下载约 227 MB（INT8）并做锁定 sha256 校验；未准备时本机识别器回答 `unprepared`，界面引导。进程内原生绑定仍是上文记录的既存风险。

## 验证

- `packages/speech/speech`：WAV 校验（规范化接纳、逐坏头命名的期望、时长上限、非默认采样率/声道）与注册表生命周期（注册/销毁、重复/不匹配拒绝、偏好解析、prepare/transcribe 委托、拒绝）。
- `packages/speech/speech-sensevoice`：下载校验（原子发布、完整性/网络/http 失败、已校验跳过）、来源排序（单来源、先应答优先、全败保序）、脚本化发布上的准备流程（下载 → 清单 → 免网重验 → 损坏修复 → 清单修复 → 失败）、懒绑定（prepare 不触 loader、首次转写加载一次、不支持语言在任何工作前拒绝）、插件注册/销毁。
- `packages/speech/speech-openai`：有序回退（传输 → 503 → 成功）、确定性 401 立即失败、链耗尽、缺密钥、语言覆盖、按密钥态就绪、插件生命周期。
- `packages/speech/speech-settings`：带默认值的命名空间注册、每次提交跟随进 `ctx.speech`、组合 base、schema 拒绝、秘密脱敏、插件卸载释放。
- `packages/host/apiproxy`（`tests/api-proxy-speech-rpc.spec.ts`）：经已解析识别器的规范化转写、seam 缺席/关闭/坏音频/超限按各自代码拒绝、识别器失败映射、prepare 观察与拒绝映射。
- `packages/client/ui-voice-input`：纯编码器/重采样套件；fake api client 与脚本化媒体上的 jsdom 套件 —— 点击状态机、停用/权限引导、空转写、CAS 未命中的手动插入、语言提示转发、按住说话的按住/松开与按键过滤、未配置键时不挂监听；设置分区写入（set/unset、键规范化、只写 API key）与 prepare 状态渲染；槽位注册 + fiber 销毁（HMR 安全）、词典、node 半边、invariant 伴随件。
- `apps/desktop`（`tests/main.spec.ts`）：麦克风仅对已连接 loopback Web origin 授予；非 media 与外部 origin 拒绝。
- 门禁：`tsc -b tsconfig.host.json` 与 `tsc -b tsconfig.client.json`（0 错误）、对所有改动文件跑 `run-oxlint.ts`（0 错误）、`vitest run packages/speech packages/client/ui-voice-input packages/host/apiproxy packages/client/connection packages/client/runtime apps/desktop/tests/main.spec.ts` 全绿、`verify-package-invariants`、`verify-cordis-config`、再生成的 `THIRD_PARTY_NOTICES.md`（verify-third-party-notices）。
- 交由 CI：带 fake recognizer 的浏览器 e2e、三 OS 打包 Desktop 资格测试、以及使用所有者凭据的真实云端端点检查。
