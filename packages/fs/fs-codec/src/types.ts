/**
 * Vocabulary for the pure text-encoding library: decode decisions, candidate
 * sources, host priors, write outcomes, and subprocess output decoding specs.
 * @module @deepseek-ai/dsh-fs-codec/types
 */

/** Where a decode decision came from; the values mirror the ordered candidate walk. */
export type EncodingSource = 'explicit' | 'sticky' | 'bom' | 'utf8' | 'host' | 'locale' | 'fallback'

/**
 * One settled decode decision. `encoding` is the canonical iconv-lite name
 * used for both decode and write-back; `bom` records whether the original
 * bytes carried (and a write-back must reproduce) a byte order mark.
 */
export interface EncodingDecision {
  /** Canonical iconv-lite encoding name, e.g. `gb18030`. */
  encoding: string
  /** Which candidate in the ordered walk produced this decision. */
  source: EncodingSource
  /** Whether the original bytes began with the encoding's byte order mark. */
  bom: boolean
  /** Dominant line-ending style of the decoded text. */
  eol: 'LF' | 'CRLF'
}

/** Host facts the ordered candidate walk derives legacy encodings from. */
export interface HostPriors {
  /** Windows ANSI code page (`GetACP`), e.g. `936`; `65001` means UTF-8. */
  acp?: number
  /** Windows OEM code page (`GetOEMCP`), used for console-output decoding order. */
  oemcp?: number
  /**
   * POSIX locale charset as written in the locale value (`GBK`, `UTF-8`, …),
   * already lowercased; absent when no locale variable names a charset.
   */
  localeCharset?: string
  /** POSIX locale language subtag (`zh`, `en`, …), lowercased. */
  localeLanguage?: string
  /** POSIX locale territory subtag (`CN`, `TW`, …), uppercased. */
  localeTerritory?: string
}

/** Injectable host facts for `hostPriors` (tests replace the Win32 bindings and env). */
export interface HostPriorsDeps {
  /** Host platform override (defaults to `process.platform`). */
  platform?: NodeJS.Platform
  /** Environment override (defaults to `process.env`). */
  env?: Record<string, string | undefined>
  /**
   * Win32 code-page probe override. The default lazily binds `GetACP`/
   * `GetOEMCP` through koffi; returning `undefined` treats the values as
   * unavailable (koffi load failure), never fatal.
   */
  loadWin32CodePages?: () => Promise<{ acp: number; oemcp: number } | undefined> | { acp: number; oemcp: number } | undefined
}

/** Complete inputs to the ordered candidate walk (`sniffAndDecode`). */
export interface SniffOptions {
  /** Explicitly requested iconv-lite encoding name; wins or fails by name. */
  explicit?: string
  /** Previously recorded decision for the same file version, re-validated like any candidate. */
  sticky?: Pick<EncodingDecision, 'encoding' | 'bom'> | undefined
  /** Host priors; pass `{}` for none. */
  priors: HostPriors
  /** Configured fallback encoding names, tried last. */
  fallbackEncodings?: readonly string[]
  /**
   * Legacy auto-detection toggle (default `true`). `false` limits the walk to
   * explicit → sticky → BOM → strict UTF-8.
   */
  detect?: boolean
  /**
   * NUL-gate sample length in bytes for the BOM/UTF-8 arms — a NUL beyond the
   * sample leaves the UTF arms free to succeed (the historical sampled-gate
   * behavior). Default: the whole buffer. The legacy arms always gate on the
   * whole buffer regardless.
   */
  binarySampleBytes?: number
}

/**
 * Outcome of the ordered candidate walk: either decoded text plus the decision
 * that produced it, or a structured rejection for the caller's error message.
 */
export type SniffOutcome =
  | { ok: true; text: string; decision: EncodingDecision }
  | {
    ok: false
    /**
     * `binary` — NUL bytes without a UTF-16 BOM (the zero-regression gate).
     * `explicit` — the requested encoding exists but cannot decode these
     * bytes cleanly. `none` — every candidate failed.
     */
    reason: 'binary' | 'explicit' | 'none'
    /** The rejected explicit name, present only for `reason: 'explicit'`. */
    encoding?: string
    /** Encodings from the fixed probe list that DO decode the bytes cleanly. */
    candidates: readonly string[]
  }

/** First character that cannot be encoded in the target encoding. */
export interface UnmappableChar {
  /** The offending character itself. */
  char: string
  /** Its Unicode code point. */
  codePoint: number
  /** 1-based line number within the submitted text. */
  line: number
  /** 1-based column, counted in code points. */
  column: number
}

/** Outcome of {@link EncodeForWriteOptions}: encoded bytes or the first unmappable character. */
export type EncodeOutcome =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; unmappable: UnmappableChar }

/** Options for encoding text back to a file's original bytes. */
export interface EncodeForWriteOptions {
  /** Reproduce the original byte order mark (honored for the UTF family only). */
  bom?: boolean
}

/** Decoding spec for collected subprocess output. Omitted means UTF-8. */
export type OutputDecodingSpec =
  | { readonly kind: 'utf-8' }
  | { readonly kind: 'mixed'; readonly legacy: readonly string[] }
