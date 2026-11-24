# Agent Note: Explicit PTC output selection through inspect

Status: implemented

English | [中文](2026-11-23-ptc-explicit-output.zh.md)

## Problem

PTC programs could only surface output as captured console text plus a completion value: the `run_code` tool rendered the returned value into the model context beside the logs, so a program that acquired large intermediate results had to either return a curated subset as its completion or print everything. Images acquired through nested `read_image` calls could not reach the model at all — nested dispatch content is session-log-only, and the outer result carried no image path.

## Decision

TypeScript `run_code` programs select text, objects, and images through the top-level `inspect(...values)` global. Strings render directly; other values render through Node's `util.inspect` without depth, array-length, or string-length preview limits, so undefined properties, Error objects, and circular references stay visible. The runtime-owned `Image` class carries a stored attachment's durable reference plus its program-readable path; Node's formatting collects images reached inside arrays and objects through the Image inspection hook, and each formatting call owns its collector. Text and selected images interleave in one ordered output sequence, so explanatory text keeps its position beside the images it describes.

The executor requests `discardCompletion: true`, so completion values are discarded before JSON validation and `run_code` answers through captured output alone — the previous rendered-value channel is gone from the tool's schema and result. Direct runtime and workflow consumers keep completion values unless they set the same option.

Host bindings may resolve to a `PtcImage` (a nested `read_image` returns exactly one image this way) or a `PtcInspectableValue`: an object- or array-valued tool result whose unchanged direct inspection renders the tool's model-facing text, while the program keeps the JSON value for programmatic access. The seam's reserved binding globals gain `inspect` and `Image` beside `console`, so one namespace list stays portable across the Node and Python backends.

The Node environment supplies `inspect` beside the complete native console; native console methods keep Node's own formatting, and their stdout/stderr writes join the captured output sequence. Python keeps `print` as its selection mechanism and gained the same `discardCompletion` option and ordered output fragments; its fragment concatenation also fixes the doubled newline `print` previously produced.

The outer result carries ordered `PtcOutput` fragments — text or durable image references — under the same combined byte budget as before; the ledger admits whole images and text prefixes, truncation discards later output without canceling execution, and the finalized `run_code` content interleaves inspected images with text beside the canonical logs-only value. Runtime warnings from the runtime's own experimental Node features are filtered out of program output.

## Alternatives considered

**Display the completion value beside printed output.** The final expression then controls context admission as well as program control flow; discarding it before validation lets a program finish with an arbitrary internal value while explicitly selecting a smaller visible result.

**Automatically forward every acquired image.** Acquisition then implies model-context cost even when the program needs several images to select one; explicit inspection gives text and images the same selection rule.

**Discover images with a separate object traversal.** A separate traversal must duplicate Node's handling of collections, symbols, and custom formatters and can emit images absent from the text representation; the Image hook ties collection to Node's own formatting.

**Bounded object previews for inspected values.** Item and string preview limits can omit file contents a program explicitly selected; removing them keeps selected contents complete within the shared output budget.

**Keep the five-method console shim.** Missing bindings and incomplete replacements can break program code and imported libraries; the native console preserves Node's methods while prompt guidance directs selection through `inspect`.

## Consequences

Programs explicitly choose the output the next model request needs, including image comparisons and selected nested results. Nested `read_image` calls still perform storage and processing work; selection controls presentation to the model. The runtime owns process-local image identity (a forged object with the same properties does not grant access); the tool executor owns the attachment reference and readable-path projection (`imageHostPath` on the attachment store, mapped through the filesystem provider). Text and image metadata share the outer output budget; `output-limit` remains the required-completion failure. Retained program Images follow their owning process's lifetime, while stored attachments follow the attachment store's.

## Verification

Node runtime: bootstrap/json-wire/output-ledger/process/process-main/persistent\* suites cover inspect rendering, image collection and reentrancy, binding inspection metadata, fragment accounting, `discardCompletion`, and the native console. Python runtime: fragment output, discard, and boundary suites. Executor: inspectable adaptation, the unreadable-image rejection, interleaved finalization, and the discard contract; spill tests pin truncated-success spilling; keyless snapshots (acp, headless, web, python-sdk) re-recorded against the inspect-based SDK.

## Deviation record (harniverse)

Ported from the official `explicit-ptc-output` line (2026-11-09 note). Deliberate deviations: the portable reserved-identifier convention (no `$`, shared cross-backend reserved globals) is kept because `ptc-runtime-python` ships here, unlike upstream; `substituteProgramImages` (MCP image-content substitution into program values) is not ported — this tree's MCP tools reduce image blocks to text placeholders, so no producer exists; the official `projectContent` hook is realized through this tree's existing `finalizeContent` contract; the run_code truncation notice stays inside the canonical logs value rather than render-only details text.
