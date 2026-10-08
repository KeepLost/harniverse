# dsh-fs-codec

English | [中文](README.zh.md)

The pure text-encoding library behind legacy-file support: strict iconv-lite decode/encode, byte-order-mark sniffing, host-locale priors, the ordered decode-candidate walk, and per-line subprocess-output decoding. `dsh-fs-local` (file reads/edits), the workbench preview host (`dsh-apiproxy`), and subprocess output collectors share this one implementation so every surface agrees on what a file's encoding is.

It is a **library, not a service or plugin**: no `ctx`, no registrations, no mutable state, no event stream. Every entry point is a pure function over whole buffers; consumers own caching, stickiness, and error surfaces.

## Why strictness is self-implemented

iconv-lite 0.7.3 (exact-pinned) has no strict mode: `decode` emits U+FFFD for invalid bytes and `encode` writes `?` for unmappable characters instead of throwing. This library therefore defines:

- **Strict decode** — any U+FFFD in the result vetoes the candidate.
- **Byte round-trip** — `encode(decode(bytes))` must reproduce the original bytes exactly, so files sitting on non-round-trippable code points are never silently rewritten.
- **Control-character ratio** — auto-detected single-byte pages additionally tolerate almost no C0/C1 control characters, so a binary blob decoded through a permissive page is rejected.
- **Explicit requests bypass the control gate** — a caller that names an encoding gets a strict decode and round-trip check, nothing else.

All decoding runs over one whole buffer. iconv's GB18030 streaming decoder drops a UTF-16 code unit when a 4-byte sequence straddles a 64 KiB chunk boundary (external defect, pinned by `tests/codec.spec.ts`); nothing in this library ever feeds iconv a partial stream, and consumers must not either.

## The ordered candidate walk

`sniffAndDecode(bytes, options)` tries, in order: explicit `encoding` → sticky prior decision → BOM (UTF-8/UTF-16LE/BE) → strict UTF-8 → host legacy page → locale-language page → configured fallbacks. A NUL byte without a UTF-16 BOM rejects as binary before any decoding (the zero-regression gate: files the UTF-8-only harness rejected stay rejected). An explicit encoding wins or fails by name — it never silently falls through — and every failed walk reports which probe encodings would have decoded the bytes cleanly, for a re-read with `encoding`.

Host priors: Windows reads `GetACP`/`GetOEMCP` through a lazily loaded koffi binding (injectable for tests); POSIX parses `LC_ALL > LC_CTYPE > LANG` and maps the charset, or — for UTF-8 locales — the language and CJK territory, to a code page (zh-CN → GB18030, zh-TW/HK → Big5, ja → Shift_JIS, ko → EUC-KR, ru/uk/bg → windows-1251, pl/cs/hu… → windows-1250, western → windows-1252, plus el/tr/he/ar/vi/th).

## Write-back

`encodeForWrite(text, encoding, { bom })` returns bytes or the first unmappable character (character, code point, line, column). Callers refuse the write (`FS_UNMAPPABLE`) rather than publishing `?`; a byte order mark is reproduced only when the read decision recorded one, and only for the UTF family.

## Subprocess output

`decodeOutputWindow(buffer, spec, opts)` implements the per-line rule for collected output: a line that is valid UTF-8 decodes as UTF-8; only an invalid line falls back to the stream's legacy pages (Windows OEM then ANSI, or a POSIX locale charset). An incomplete trailing sequence is held back so the next read starts on a boundary — returned `nextOffset` values may therefore sit before the newest retained byte. A window sliced mid-sequence by a foreign offset (leading continuation byte) decodes as UTF-8 instead of falling back, because several legacy lead bytes overlap the UTF-8 continuation range.

## Model Experience

Indirectly, through consumers such as `dsh-tool-fs` (whose `read` output carries `[Encoding: …]` annotations produced here) and `dsh-fs-local` (whose `FS_NOT_TEXT` rejections list the viable candidates computed here).

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Cross-locale files need an explicit encoding** — a Big5 file on a GB18030-prior host decodes as mojibake through the host page; auto-detection is host-prior based, not statistical.
- **Files containing a literal U+FFFD are vetoed everywhere** — the strict-decode gate cannot distinguish a real replacement character from a decode failure.
- **Inherent two-byte ambiguity** — some legacy two-byte sequences are simultaneously valid UTF-8 (and other pages); the candidate order decides.
- **No statistical detector** — chardetng-style detection was evaluated and excluded; missing encodings (ISO-2022 family, EBCDIC, EUC-TW, Johab, HZ) stay outside iconv-lite's reach.
- **Single-byte classification is a fixed name set** — the control-ratio gate consults a maintained list of single-byte encodings; exotic fallback names are treated as multi-byte.
