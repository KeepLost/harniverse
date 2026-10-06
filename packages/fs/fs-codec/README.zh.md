# dsh-fs-codec

[English](README.md) | 中文

遗留文件支持背后的纯文本编码库：严格的 iconv-lite 编解码、字节序标记嗅探、主机 locale 先验、有序的解码候选走查，以及子进程输出的逐行解码。`dsh-fs-local`（文件读取/编辑）、工作台预览宿主（`dsh-apiproxy`）与子进程输出收集器共用这同一份实现，因此所有界面对“文件编码是什么”保持一致判断。

它是**库，不是服务或插件**：没有 `ctx`、没有注册、没有可变状态、没有事件流。每个入口都是作用于整段缓冲的纯函数；缓存、粘性与错误展示归消费方所有。

## 为什么严格性必须自实现

iconv-lite 0.7.3（精确钉版）没有严格模式：`decode` 对非法字节输出 U+FFFD，`encode` 对不可映射字符写 `?`，都不抛错。本库因此定义：

- **严格解码** —— 结果含任何 U+FFFD 即否决该候选。
- **字节往返** —— `encode(decode(bytes))` 必须与原始字节完全一致，落在不可往返码位上的文件绝不 silently 重写。
- **控制字符比例** —— 自动检测的单字节代码页额外要求几乎没有 C0/C1 控制字符，防止二进制数据经由宽容代码页被当成文本。
- **显式请求绕过控制闸门** —— 调用方点名编码时只做严格解码与往返校验。

所有解码都作用于单一整段缓冲。iconv 的 GB18030 流式解码器在 4 字节序列跨 64 KiB 分块边界时会丢一个 UTF-16 码元（外部缺陷，由 `tests/codec.spec.ts` 钉住）；本库绝不向 iconv 喂部分流，消费方也不得这样做。

## 有序候选走查

`sniffAndDecode(bytes, options)` 依次尝试：显式 `encoding` → 粘性旧决定 → BOM（UTF-8/UTF-16LE/BE）→ 严格 UTF-8 → 主机遗留页 → locale 语言页 → 配置回退。含 NUL 且无 UTF-16 BOM 的缓冲在任何解码之前按二进制拒绝（零回归闸门：纯 UTF-8 时代读不了的文件仍被拒绝）。显式编码要么成功要么点名失败，绝不静默落入后续候选；走查全部失败时返回能干净解码的探测编码清单，供带 `encoding` 重读。

主机先验：Windows 经懒加载的 koffi 绑定读取 `GetACP`/`GetOEMCP`（测试可注入）；POSIX 解析 `LC_ALL > LC_CTYPE > LANG`，按字符集映射，字符集为 UTF-8 时按语言与 CJK 地区映射代码页（zh-CN → GB18030、zh-TW/HK → Big5、ja → Shift_JIS、ko → EUC-KR、ru/uk/bg → windows-1251、pl/cs/hu 等 → windows-1250、西欧 → windows-1252，另有 el/tr/he/ar/vi/th）。

## 写回

`encodeForWrite(text, encoding, { bom })` 返回字节或首个不可映射字符（字符、码点、行列）。调用方拒绝写入（`FS_UNMAPPABLE`）而不是发布 `?`；仅当读取决定记录了 BOM 且目标属于 UTF 家族时才复现字节序标记。

## 子进程输出

`decodeOutputWindow(buffer, spec, opts)` 实现收集输出的逐行规则：合法 UTF-8 的行按 UTF-8 解码；仅非法行回退到流级遗留页（Windows 先 OEM 后 ANSI，或 POSIX locale 字符集）。不完整的尾部序列被保留，下次读取从边界开始 —— 返回的 `nextOffset` 因此可能早于最新保留字节。被外部偏移切成半个字符的窗口（行首出现续字节）按 UTF-8 解码而不回退，因为若干遗留前导字节与 UTF-8 续字节区间重叠。

## Model Experience

间接，经消费方如 `dsh-tool-fs`（其 `read` 输出携带此处生成的 `[Encoding: …]` 标注）与 `dsh-fs-local`（其 `FS_NOT_TEXT` 拒绝列出此处计算的可用候选）。

#### KV Cache effect

无直接失效；上述消费方拥有各自的请求前缀变化。

## Known Limitations and Deferred Work

- **跨地区文件需要显式 encoding** —— GB18030 先验主机上的 Big5 文件会经主机页解码为乱码；自动检测基于主机先验而非统计。
- **含真实 U+FFFD 的文件被一票否决** —— 严格解码闸门无法区分真实的替换字符与解码失败。
- **双字节的固有歧义** —— 部分遗留双字节序列同时是合法 UTF-8（或其他页）；由候选顺序裁决。
- **没有统计检测器** —— chardetng 一类检测器已评估并排除；iconv-lite 覆盖之外的编码（ISO-2022 系、EBCDIC、EUC-TW、Johab、HZ）不在支持范围。
- **单字节判定是固定名单** —— 控制比例闸门查询一份维护的单字节编码名单；冷门回退名按多字节对待。
