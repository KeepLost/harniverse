/** `voice` namespace dictionaries (the microphone control and the settings section). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'voice'


/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mic.start': '开始语音输入',
  'mic.stop': '停止录音并转写',
  'mic.cancel': '取消录音',
  'mic.recording': '录音中…',
  'mic.transcribing': '转写中…',
  'mic.requesting': '正在获取麦克风…',
  'mic.insertFailed': '输入框已变化，转写未插入：',
  'mic.empty': '没有识别到语音',
  'mic.off': '语音输入未启用：在设置 → 语音输入中选择识别器',
  'mic.denied': '麦克风权限被拒绝：请在浏览器地址栏允许麦克风访问',
  'mic.unsupported': '当前浏览器不支持录音',
  'mic.failed': '转写失败：',
  'settings.nav': '语音输入',
  'settings.description': '将麦克风录音转写为文字填入输入框。',
  'settings.recognizer': '识别器',
  'settings.recognizer.off': '关闭',
  'settings.recognizer.sensevoice': 'SenseVoice（本地）',
  'settings.recognizer.openai-compatible': 'OpenAI 兼容云端',
  'settings.language': '语言（留空自动检测）',
  'settings.language.placeholder': '如 zh、en、ja、ko、yue',
  'settings.pushToTalkKey': '按住说话键（如 shift，留空停用）',
  'settings.pushToTalkKey.placeholder': '如 shift',
  'settings.modelVariant': '本地模型精度',
  'settings.modelVariant.int8': 'INT8（更小下载）',
  'settings.modelVariant.fp32': 'FP32（更高精度）',
  'settings.apiKey': '云端 API Key',
  'settings.apiKey.placeholder': '写入后不会回显',
  'settings.apiKey.set': '已配置（写入不回显，清空即移除）',
  'settings.prepare': '下载 / 准备本地模型',
  'settings.preparing': '准备中…（首次下载可能需要数分钟）',
  'settings.prepare.ready': '本地模型已就绪',
  'settings.prepare.unprepared': '尚未准备：点击下载并校验模型',
  'settings.prepare.failed': '准备失败：',
  'settings.prepare.check': '检查状态',
} satisfies Record<string, string>

/** The voice namespace key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mic.start': 'Start voice input',
  'mic.stop': 'Stop recording and transcribe',
  'mic.cancel': 'Cancel recording',
  'mic.recording': 'Recording…',
  'mic.transcribing': 'Transcribing…',
  'mic.requesting': 'Requesting microphone…',
  'mic.insertFailed': 'The composer changed, transcript not inserted: ',
  'mic.empty': 'No speech recognized',
  'mic.off': 'Voice input is off: pick a recognizer in Settings → Voice input',
  'mic.denied': 'Microphone permission denied: allow microphone access in the browser address bar',
  'mic.unsupported': 'Recording is not supported in this browser',
  'mic.failed': 'Transcription failed: ',
  'settings.nav': 'Voice input',
  'settings.description': 'Transcribe microphone recordings into the composer draft.',
  'settings.recognizer': 'Recognizer',
  'settings.recognizer.off': 'Off',
  'settings.recognizer.sensevoice': 'SenseVoice (local)',
  'settings.recognizer.openai-compatible': 'OpenAI-compatible cloud',
  'settings.language': 'Language (empty for auto-detect)',
  'settings.language.placeholder': 'e.g. zh, en, ja, ko, yue',
  'settings.pushToTalkKey': 'Push-to-talk key (e.g. shift, empty disables)',
  'settings.pushToTalkKey.placeholder': 'e.g. shift',
  'settings.modelVariant': 'Local model precision',
  'settings.modelVariant.int8': 'INT8 (smaller download)',
  'settings.modelVariant.fp32': 'FP32 (higher precision)',
  'settings.apiKey': 'Cloud API key',
  'settings.apiKey.placeholder': 'Write-only; never echoed',
  'settings.apiKey.set': 'Configured (write-only; clear to remove)',
  'settings.prepare': 'Download / prepare local model',
  'settings.preparing': 'Preparing… (the first download may take minutes)',
  'settings.prepare.ready': 'Local model ready',
  'settings.prepare.unprepared': 'Not prepared yet: click to download and verify',
  'settings.prepare.failed': 'Preparation failed: ',
  'settings.prepare.check': 'Check status',
} satisfies Record<VoiceKey, string>
