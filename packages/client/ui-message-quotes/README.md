# @deepseek-ai/dsh-client-ui-message-quotes

English | [中文](README.zh.md)

Blockquote presentation for sent Web user text. A user message whose consecutive lines each carry an explicit Markdown blockquote marker — a `>` after up to three leading spaces — draws that span as one quoted excerpt: a left-ruled block in secondary color with a single marker level removed. Deeper markers and inner Markdown stay literal; the excerpt is never re-interpreted. Quoting changes only what is drawn; the message text, the copy action, and the model input keep the original characters.

This is a pure client plugin: it registers one rule into the conversation service's sent-user-text face (`ctx.conversation.sentUserText`). The shipped Web composition mounts it; removing its row draws quoted lines as written.

## Use this package

Mount the plugin beside `dsh-client-ui-conversation`. Every user bubble drawn by the conversation chat view consults the seam: plain segments keep the existing reference-chip decoration, matched spans render through the rule's `QuotedUserText` component. The presentation has no interaction; interactive and pending pre-admission rows draw the same excerpt.

## What is recognized

| Input | Examples | Display |
| --- | --- | --- |
| Consecutive explicit quote lines | `> first\n> line` | One excerpt, one `>` level stripped |
| Indented markers | `␣␣> text` (up to three spaces) | Same excerpt; marker plus its one following space/tab stripped |
| Deeper quote levels | `> > nested` | `> nested`, drawn literally |
| Inline greater-than signs | `a > b` | Ordinary text |
| Indented code | four or more leading spaces before `>` | Ordinary text |
| Blank excerpts | `> ` alone | Ordinary text (nothing drawn) |

A span ends at the first line without its own marker; a nonblank excerpt is required, so marker-only or whitespace-only spans stay plain.

## Implementation

The recognizer is the recognition half of the official `dsh-session-message-quotes` plugin, ported near-verbatim: `quoteTextOf` strips one marker per line and normalizes line endings; `messageQuoteRanges` scans explicit marker spans with original UTF-16 offsets. The rule memoizes one text's spans, so the seam's advancing-offset queries rescan nothing. The official selection button and its locale dictionaries are out of scope and not ported.

## Model Experience

None, as quoting is display-only in the Web client: no durable event, tool schema, or model request changes.

#### KV Cache effect

Quoting never leaves the browser; no request prefix exists to invalidate.

## Known Limitations and Deferred Work

- **Only sent user text is quoted** — assistant output, tool results, and the composer draft render as written.
- **Lazy continuation is not recognized** — a quoted paragraph followed by an unmarked continuation line draws the continuation outside the excerpt, per the explicit-marker-only contract.
- **One marker level is stripped** — deeper levels draw literally inside the excerpt rather than nesting visually.
