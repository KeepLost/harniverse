/**
 * Legacy-encoding behavior of the local backend: per-encoding byte-exact
 * read→edit→write round trips, BOM preservation, the zero-regression gates
 * (NUL, utfOnly, detect), fallback configuration, sticky decision lifetime,
 * unmappable-refusing writes, and the whole-buffer GB18030 regression.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { encodeForWrite } from '@deepseek-ai/dsh-fs-codec'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { FsTextEncoding } from '@deepseek-ai/dsh-fs'

/** Encode fixture text through the codec library (tests cannot reach iconv-lite directly). */
function enc(text: string, encoding: string): Buffer {
  const outcome = encodeForWrite(text, encoding)
  if (!outcome.ok) throw new Error(`fixture text is not representable in ${encoding}`)
  return Buffer.from(outcome.bytes)
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

let dir: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-enc-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
  // Never inherit the machine's code page (Windows GetACP) or locale: tests that
  // need a legacy prior opt in through `mountWithPriors`.
  fs.resolvePriors = async () => ({})
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

/** Mount with injected host priors (deterministic legacy detection). */
async function mountWithPriors(priors: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<void> {
  await fiber.dispose()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir, ...config })
  fs = ctx.fs as LocalFileSystem
  fs.resolvePriors = async () => priors
}

describe('read → edit → write byte-exact round trips', () => {
  const cases: { name: string; encoding: string; priors: Record<string, unknown>; text: string }[] = [
    { name: 'GB18030 over GBK bytes', encoding: 'gb18030', priors: { localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' }, text: '老机器上的配置\n第二行 DEBUG\n' },
    { name: 'Big5', encoding: 'big5', priors: { localeCharset: 'big5', localeLanguage: 'zh', localeTerritory: 'TW' }, text: '繁體中文測試\n第三行\n' },
    { name: 'Shift_JIS', encoding: 'shiftjis', priors: { localeCharset: 'sjis', localeLanguage: 'ja', localeTerritory: 'JP' }, text: '日本語のファイル\nつぎの行\n' },
    { name: 'EUC-KR', encoding: 'cp949', priors: { localeCharset: 'euckr', localeLanguage: 'ko', localeTerritory: 'KR' }, text: '한국어 파일\n다음 줄\n' },
    { name: 'windows-1251', encoding: 'windows-1251', priors: { localeCharset: 'utf-8', localeLanguage: 'ru', localeTerritory: 'RU' }, text: 'Русский текст\nстрока два\n' },
  ]

  for (const entry of cases) {
    it(`round-trips ${entry.name} through read, edit, and write`, async () => {
      await mountWithPriors(entry.priors)
      const bytes = enc(entry.text, entry.encoding)
      await writeFile(join(dir, 'legacy.txt'), bytes)
      const target = await fs.resolve('legacy.txt')

      let decision: FsTextEncoding | undefined
      const text = await fs.readText(target, undefined, { onDecision: (value) => { decision = value } })
      expect(text).toBe(entry.text)
      expect(decision).toMatchObject({ encoding: entry.encoding, bom: false })

      const secondLine = entry.text.split('\n')[1] ?? ''
      const firstLine = entry.text.split('\n')[0] ?? ''
      const version = (await fs.stat(target))!.version
      const outcome = await fs.editText(target, { oldString: secondLine, newString: 'REPLACED', replaceAll: false }, { version })
      expect(outcome.before).toBe(text.replaceAll('\r\n', '\n'))
      const expected = enc(`${firstLine}\nREPLACED\n`, entry.encoding)
      expect(await readFile(join(dir, 'legacy.txt'))).toEqual(expected)
    })
  }

  it('round-trips a GB18030 4-byte sequence across the 64 KiB boundary', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    const text = 'x'.repeat(65_533) + '𠀀' + 'y'.repeat(100) + '\n'
    await writeFile(join(dir, 'gb.txt'), enc(text, 'gb18030'))
    const target = await fs.resolve('gb.txt')
    expect(await fs.readText(target)).toBe(text)
    const version = (await fs.stat(target))!.version
    await fs.editText(target, { oldString: '𠀀', newString: '代', replaceAll: false }, { version })
    const edited = 'x'.repeat(65_533) + '代' + 'y'.repeat(100) + '\n'
    expect(await readFile(join(dir, 'gb.txt'))).toEqual(enc(edited, 'gb18030'))
  })

  it('round-trips UTF-16LE with BOM and preserves its BOM on write-back', async () => {
    await writeFile(join(dir, 'u16.txt'), Buffer.concat([UTF16LE_BOM, enc('汉字\n下一行\n', 'utf-16le')]))
    const target = await fs.resolve('u16.txt')
    let decision: FsTextEncoding | undefined
    expect(await fs.readText(target, undefined, { onDecision: (value) => { decision = value } })).toBe('汉字\n下一行\n')
    expect(decision).toMatchObject({ encoding: 'utf-16le', source: 'bom', bom: true, eol: 'LF' })
    const version = (await fs.stat(target))!.version
    await fs.editText(target, { oldString: '汉字', newString: '符号', replaceAll: false }, { version })
    expect(await readFile(join(dir, 'u16.txt'))).toEqual(Buffer.concat([UTF16LE_BOM, enc('符号\n下一行\n', 'utf-16le')]))
  })

  it('round-trips UTF-16BE with BOM', async () => {
    const be = (text: string): Buffer => enc(text, 'utf-16le').swap16()
    await writeFile(join(dir, 'u16be.txt'), Buffer.concat([UTF16BE_BOM, be('英語と日本語\n')]))
    const target = await fs.resolve('u16be.txt')
    expect(await fs.readText(target)).toBe('英語と日本語\n')
    const version = (await fs.stat(target))!.version
    await fs.editText(target, { oldString: '日本語', newString: '中国語', replaceAll: false }, { version })
    expect(await readFile(join(dir, 'u16be.txt'))).toEqual(Buffer.concat([UTF16BE_BOM, be('英語と中国語\n')]))
  })
})

describe('UTF-8 BOM preservation (the fixed bug)', () => {
  it('strips the BOM on read, records it, and writes it back through edit', async () => {
    await writeFile(join(dir, 'bom.txt'), Buffer.concat([UTF8_BOM, Buffer.from('alpha\nbeta\n')]))
    const target = await fs.resolve('bom.txt')
    let decision: FsTextEncoding | undefined
    expect(await fs.readText(target, undefined, { onDecision: (value) => { decision = value } })).toBe('alpha\nbeta\n')
    expect(decision).toMatchObject({ encoding: 'utf-8', source: 'bom', bom: true })
    const version = (await fs.stat(target))!.version
    await fs.editText(target, { oldString: 'alpha', newString: 'gamma', replaceAll: false }, { version })
    expect(await readFile(join(dir, 'bom.txt'))).toEqual(Buffer.concat([UTF8_BOM, Buffer.from('gamma\nbeta\n')]))
  })

  it('preserves the BOM on a guarded overwrite that follows a read', async () => {
    await writeFile(join(dir, 'bom2.txt'), Buffer.concat([UTF8_BOM, Buffer.from('内容\n')]))
    const target = await fs.resolve('bom2.txt')
    await fs.readText(target)
    const version = (await fs.stat(target))!.version
    await fs.writeText(target, '新内容\n', { kind: 'replaceIfVersion', version })
    expect(await readFile(join(dir, 'bom2.txt'))).toEqual(Buffer.concat([UTF8_BOM, Buffer.from('新内容\n')]))
  })

  it('writes a new file as UTF-8 without a BOM', async () => {
    const target = await fs.resolve('fresh.txt')
    await fs.writeText(target, 'plain\n', { kind: 'createIfAbsent' })
    expect(await readFile(join(dir, 'fresh.txt'))).toEqual(Buffer.from('plain\n'))
  })
})

describe('zero-regression gates', () => {
  it('still rejects a NUL file without a UTF-16 BOM', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    const target = await fs.resolve('bin')
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(fs.editText(target, { oldString: 'h', newString: 'H', replaceAll: false })).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('utfOnly rejects a legacy file that plain decoding would accept', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    await writeFile(join(dir, 'gbk.txt'), enc('你好\n', 'gbk'))
    const target = await fs.resolve('gbk.txt')
    await expect(fs.readText(target, undefined, { utfOnly: true })).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    let streamed = ''
    await expect(async () => {
      for await (const chunk of await fs.streamText(target, undefined, { utfOnly: true })) streamed += chunk
    }).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    expect(streamed).toBe('')
  })

  it('utfOnly still reads valid UTF-8', async () => {
    await writeFile(join(dir, 'ok.txt'), 'héllo\n')
    const target = await fs.resolve('ok.txt')
    expect(await fs.readText(target, undefined, { utfOnly: true })).toBe('héllo\n')
  })

  it('detect=false leaves explicit, BOM, and UTF-8 only', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' }, { detect: false })
    await writeFile(join(dir, 'gbk.txt'), enc('你好\n', 'gbk'))
    const target = await fs.resolve('gbk.txt')
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    expect(await fs.readText(target, undefined, { encoding: 'gbk' })).toBe('你好\n')
  })
})

describe('explicit encoding reads', () => {
  it('decodes with a requested encoding and reports source explicit', async () => {
    await writeFile(join(dir, 'sjis.txt'), enc('日本語\n', 'shiftjis'))
    const target = await fs.resolve('sjis.txt')
    let decision: FsTextEncoding | undefined
    expect(await fs.readText(target, undefined, { encoding: 'shiftjis', onDecision: (value) => { decision = value } })).toBe('日本語\n')
    expect(decision).toMatchObject({ encoding: 'shiftjis', source: 'explicit' })
  })

  it('fails by name when the requested encoding cannot decode the bytes', async () => {
    await writeFile(join(dir, 'bad.bin'), Buffer.from([0x81, 0x7f, 0x0a]))
    const target = await fs.resolve('bad.bin')
    await expect(fs.readText(target, undefined, { encoding: 'gbk' }))
      .rejects.toThrow(/not decodable as GBK/)
  })

  it('reports viable candidates for a file no ordered candidate decodes', async () => {
    // Invalid UTF-8 and invalid GB18030, but clean windows-1252/1251 text.
    await writeFile(join(dir, 'west.bin'), Buffer.from([0xc4, 0x2e, 0x43, 0x34, 0x0a]))
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    const target = await fs.resolve('west.bin')
    await expect(fs.readText(target)).rejects.toThrow(/viable encodings: .+read\(\{"file_path":"/)
  })
})

describe('fallbackEncodings configuration', () => {
  it('hits a configured fallback after the priors miss', async () => {
    await mountWithPriors({}, { fallbackEncodings: ['big5'] })
    await writeFile(join(dir, 'big5.txt'), enc('繁體中文\n', 'big5'))
    const target = await fs.resolve('big5.txt')
    let decision: FsTextEncoding | undefined
    expect(await fs.readText(target, undefined, { onDecision: (value) => { decision = value } })).toBe('繁體中文\n')
    expect(decision).toMatchObject({ encoding: 'big5', source: 'fallback' })
  })

  it('fails construction on an unknown encoding name', async () => {
    const bare = new Context()
    await expect(bare.plugin(LocalFileSystem, { cwd: dir, fallbackEncodings: ['not-a-codec'] })).rejects.toThrow(/unknown encoding names: not-a-codec/)
  })
})

describe('sticky decisions', () => {
  it('reuses the recorded decision for an unchanged version across reads', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    await writeFile(join(dir, 'sticky.txt'), enc('你好\n', 'gbk'))
    const target = await fs.resolve('sticky.txt')
    let first: FsTextEncoding | undefined
    let second: FsTextEncoding | undefined
    await fs.readText(target, undefined, { onDecision: (value) => { first = value } })
    await fs.readText(target, undefined, { onDecision: (value) => { second = value } })
    expect(first).toMatchObject({ source: 'host' })
    expect(second).toMatchObject({ source: 'sticky', encoding: first!.encoding })
  })

  it('invalidates the record when the version moves', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    await writeFile(join(dir, 'move.txt'), enc('你好\n', 'gbk'))
    const target = await fs.resolve('move.txt')
    await fs.readText(target)
    await writeFile(join(dir, 'move.txt'), enc('再见\n', 'gbk'))
    // Same byte length, and two quick writes can share one timestamp tick (Windows): pin a distinct
    // mtime so the version moves deterministically.
    await utimes(join(dir, 'move.txt'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    let decision: FsTextEncoding | undefined
    await fs.readText(await fs.resolve('move.txt'), undefined, { onDecision: (value) => { decision = value } })
    expect(decision).toMatchObject({ source: 'host' })
  })

  it('clears recorded decisions on disposal (HMR safety)', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    await writeFile(join(dir, 'hmr.txt'), enc('你好\n', 'gbk'))
    await fs.readText(await fs.resolve('hmr.txt'))
    const records = () => (fs as unknown as { encodingRecords: Map<string, unknown> }).encodingRecords.size
    expect(records()).toBe(1)
    await fiber.dispose()
    expect(records()).toBe(0)
  })
})

describe('unmappable write refusal', () => {
  it('refuses an edit introducing an unencodable character, leaving the file untouched', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    const original = enc('旧内容\n', 'gbk')
    await writeFile(join(dir, 'keep.txt'), original)
    const target = await fs.resolve('keep.txt')
    // GB18030 (the host prior) encodes everything; pin the non-total GBK
    // codec through an explicit read so unmappability is reachable.
    await fs.readText(target, undefined, { encoding: 'gbk' })
    const version = (await fs.stat(target))!.version
    await expect(fs.editText(target, { oldString: '旧内容', newString: 'emoji \u{1f600}', replaceAll: false }, { version }))
      .rejects.toMatchObject({ code: 'FS_UNMAPPABLE' })
    expect(await readFile(join(dir, 'keep.txt'))).toEqual(original)
  })

  it('refuses a guarded overwrite with unencodable content', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    const original = enc('旧内容\n', 'gbk')
    await writeFile(join(dir, 'keep2.txt'), original)
    const target = await fs.resolve('keep2.txt')
    await fs.readText(target, undefined, { encoding: 'gbk' })
    const version = (await fs.stat(target))!.version
    await expect(fs.writeText(target, 'bad \u{1f600} content\n', { kind: 'replaceIfVersion', version }))
      .rejects.toMatchObject({ code: 'FS_UNMAPPABLE' })
    expect(await readFile(join(dir, 'keep2.txt'))).toEqual(original)
  })
})

describe('streamText decode path', () => {
  it('streams decoded legacy text in order and reports the decision', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    const text = `第一行内容\n${'x'.repeat(70_000)}\n尾巴\n`
    await writeFile(join(dir, 'stream.txt'), enc(text, 'gb18030'))
    const target = await fs.resolve('stream.txt')
    let decision: FsTextEncoding | undefined
    let streamed = ''
    for await (const chunk of await fs.streamText(target, undefined, { onDecision: (value) => { decision = value } })) {
      streamed += chunk
    }
    expect(streamed).toBe(text)
    expect(decision).toMatchObject({ encoding: 'gb18030', source: 'host' })
  })

  it('keeps the historical streaming behavior for plain UTF-8 files', async () => {
    await writeFile(join(dir, 'plain.txt'), Buffer.concat([UTF8_BOM, Buffer.from('one\ntwo\n')]))
    const target = await fs.resolve('plain.txt')
    let decision: FsTextEncoding | undefined
    let streamed = ''
    for await (const chunk of await fs.streamText(target, undefined, { onDecision: (value) => { decision = value } })) {
      streamed += chunk
    }
    expect(streamed).toBe('one\ntwo\n')
    expect(decision).toMatchObject({ encoding: 'utf-8', source: 'bom', bom: true, eol: 'LF' })
  })

  it('CRLF eol is reported from the decoded head', async () => {
    await writeFile(join(dir, 'crlf.txt'), 'a\r\nb\r\nc\n')
    const target = await fs.resolve('crlf.txt')
    let decision: FsTextEncoding | undefined
    for await (const _chunk of await fs.streamText(target, undefined, { onDecision: (value) => { decision = value } })) {
      // drain
    }
    expect(decision).toMatchObject({ eol: 'CRLF' })
  })
})

describe('stream fast-path tail arms', () => {
  it('keeps streaming when the 8 KiB prefix ends inside a multi-byte sequence', async () => {
    // 8191 ASCII bytes then a dangling 2-byte lead: the prefix check trims it
    // and the fast path streams the rest without a whole-buffer decode.
    await writeFile(join(dir, 'cut-lead.txt'), Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from([0xc3, 0xa9]), Buffer.from('x\n')]))
    const target = await fs.resolve('cut-lead.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(`${'a'.repeat(8191)}\u00e9x\n`)
  })

  it('reports the historical invalid-UTF-8 error when a far byte breaks the stream', async () => {
    await writeFile(join(dir, 'late-bad.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0xff])]))
    const target = await fs.resolve('late-bad.txt')
    await expect(async () => {
      for await (const _chunk of await fs.streamText(target)) {
        // The 0xff rides the first delivered chunk, so nothing precedes the error.
      }
    }).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('fails a continuation-only prefix on the streaming path when no legacy prior applies', async () => {
    await mountWithPriors({})
    await writeFile(join(dir, 'cont-only.txt'), Buffer.from([0x80, 0x80, 0x0a]))
    const target = await fs.resolve('cont-only.txt')
    // The whole continuation run is trimmed from the prefix check; without a
    // host or locale prior no legacy candidate is tried, so the orphan bytes reject.
    await expect(async () => {
      for await (const _chunk of await fs.streamText(target)) {
        // Rejection precedes any delivered chunk.
      }
    }).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('decodes a continuation-only prefix through the western locale prior', async () => {
    await mountWithPriors({ localeCharset: 'utf-8', localeLanguage: 'en', localeTerritory: 'US' })
    await writeFile(join(dir, 'cont-only.txt'), Buffer.from([0x80, 0x80, 0x0a]))
    const target = await fs.resolve('cont-only.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('\u20ac\u20ac\n')
  })
})

describe('stream prefix tail-framing arms', () => {
  const cases: { name: string; prefixTail: number[]; rest: number[]; expected: string }[] = [
    { name: 'dangling 2-byte lead', prefixTail: [0xc3], rest: [0xa9, 0x0a], expected: 'é\n' },
    { name: 'dangling 3-byte lead', prefixTail: [0xe4], rest: [0xb8, 0x80, 0x0a], expected: '一\n' },
    { name: 'dangling 4-byte lead', prefixTail: [0xf0], rest: [0x9f, 0x98, 0x80, 0x0a], expected: '😀\n' },
    { name: 'incomplete 3-byte run', prefixTail: [0xe4, 0xb8], rest: [0x80, 0x0a], expected: '一\n' },
    { name: 'incomplete 4-byte run', prefixTail: [0xf0, 0x9f], rest: [0x98, 0x80, 0x0a], expected: '😀\n' },
  ]

  for (const entry of cases) {
    it(`streams a ${entry.name} at the 8 KiB prefix boundary`, async () => {
      const body = Buffer.concat([
        Buffer.alloc(8192 - entry.prefixTail.length, 0x61),
        Buffer.from(entry.prefixTail),
        Buffer.from(entry.rest),
      ])
      await writeFile(join(dir, `${entry.name.replace(/ /g, '-')}.txt`), body)
      const target = await fs.resolve(`${entry.name.replace(/ /g, '-')}.txt`)
      let streamed = ''
      for await (const chunk of await fs.streamText(target)) streamed += chunk
      expect(streamed).toBe(`${'a'.repeat(8192 - entry.prefixTail.length)}${entry.expected}`)
    })
  }
})

describe('writeText legacy basis', () => {
  it('decodes a legacy prior through the diff basis with the sticky decision', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    const original = enc('旧内容\n', 'gbk')
    await writeFile(join(dir, 'basis.txt'), original)
    const target = await fs.resolve('basis.txt')
    await fs.readText(target)
    const version = (await fs.stat(target))!.version
    const outcome = await fs.writeText(target, '新内容\n', { kind: 'replaceIfVersion', version })
    expect(outcome.before).toBe('旧内容\n')
    expect(await readFile(join(dir, 'basis.txt'))).toEqual(enc('新内容\n', 'gbk'))
  })
})

describe('stream prefix framing edges', () => {
  it('streams an empty file through the fast path', async () => {
    await writeFile(join(dir, 'empty.txt'), Buffer.alloc(0))
    const target = await fs.resolve('empty.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('')
  })

  it('rejects a one-byte continuation-only file on the streaming decoder', async () => {
    await writeFile(join(dir, 'one.txt'), Buffer.from([0x80]))
    const target = await fs.resolve('one.txt')
    await expect(async () => {
      for await (const _chunk of await fs.streamText(target)) {
        // The orphan continuation byte fails the fatal stream decoder.
      }
    }).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('streams a prefix ending exactly on a complete multi-byte sequence', async () => {
    await writeFile(join(dir, 'complete.txt'), Buffer.concat([Buffer.alloc(8190, 0x61), Buffer.from([0xc3, 0xa9])]))
    const target = await fs.resolve('complete.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(`${'a'.repeat(8190)}é`)
  })

  it('reuses a recorded legacy decision on the second streamed read', async () => {
    await mountWithPriors({ localeCharset: 'gbk', localeLanguage: 'zh', localeTerritory: 'CN' })
    await writeFile(join(dir, 'twice.txt'), enc('你好\n', 'gbk'))
    const target = await fs.resolve('twice.txt')
    let first: FsTextEncoding | undefined
    let second: FsTextEncoding | undefined
    for await (const _chunk of await fs.streamText(target, undefined, { onDecision: (value) => { first = value } })) {
      // drain
    }
    for await (const _chunk of await fs.streamText(target, undefined, { onDecision: (value) => { second = value } })) {
      // drain
    }
    expect(first).toMatchObject({ source: 'host' })
    expect(second).toMatchObject({ source: 'sticky', encoding: 'gb18030' })
  })
})
