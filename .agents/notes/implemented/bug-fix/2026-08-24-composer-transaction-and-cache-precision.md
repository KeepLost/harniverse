# Agent Note: Composer transaction safety and cache-hit precision

Status: implemented

English | [中文](2026-08-24-composer-transaction-and-cache-precision.zh.md)

## Problem

The Web conversation composer cleared ordinary sends optimistically and let the default sink continue outside the input machine's submission attempt. A second Enter could therefore submit the same draft while reference serialization, image encoding, or Host admission remained unresolved. Failure restoration then had to reconstruct text and images after ownership had already moved, which could overwrite later typing, reuse an image already claimed by another send, or publish after session-scope disposal.

Image-only submission followed a separate fire-and-forget path with no in-flight owner. Repeated activation duplicated the send, while a concurrent text send could capture the same draft image ids. Aborting only the visible machine state was insufficient because serializer, sink, and upload promises could remain live after the shell had been released.

The same stats strip had a precision defect. `Math.round(cacheReadTokens / billedInputTokens * 100)` displays `100%` for sufficiently close but incomplete cache hits. A user-facing full-hit label must mean that uncached input and cache writes are both exactly zero, including near `Number.MAX_SAFE_INTEGER` where multiplying token counts by an expanding decimal scale would exceed safe integer arithmetic.

## Decision

Every text-bearing Queue, Steer, and slash-miss send has one `SubmitAttempt` from Enter through adjudication when present, reference serialization, browser image encoding, and Host prompt admission. The input machine remains in `submitting` until that attempt's `SubmitOutcome` settles, so repeated Enter is ignored rather than creating a second lifecycle owner. Queue and Steer remain the mode captured by the original gesture; transaction ownership neither promotes, reorders, nor changes delivery policy.

A successful text-bearing send consumes only the submitted draft snapshot and captured image ids. Text appended as a pure suffix while admission is pending remains in the composer; an interleaved edit that cannot be separated safely from the submitted snapshot is not guessed back into place. Errors and rejections retain the live draft and release the same submission slot for retry.

An image-only send has its own single `ImageSendAttempt`. It reserves its captured image ids while unresolved, suppresses duplicate image-only activation, and leaves those ids unavailable to a concurrent text send. Failure releases the reservation without removing the images. Success removes only the captured ids and consumes the captured text snapshot only while the input machine is still plain, so a later command or adjudication transaction keeps its draft ownership.

The shell retains every adjudication, serialization, and sink completion. Release aborts the active machine attempt and image-only controller; the attempt signal reaches reference serializers and the sink, and the sink forwards it through image encoding and Host admission. Late settlements publish nothing. Disposal joins one memoized drain and resolves only after all retained completions settle; one serializer failure aborts its siblings and awaits the whole fan-out before the attempt unlocks.

Cache-hit formatting returns `100` only when `uncachedInputTokens + cacheWriteTokens` is exactly zero. Ordinary ratios retain integer display. If integer rounding would produce 100 for an incomplete hit, the formatter finds the minimum decimal precision whose rounded value remains below 100. It compares safe-integer token counts through quotient/remainder decomposition and small bounded factors rather than multiplying a full denominator by an unbounded power of ten, so the distinction remains exact across the supported `number` range.

## Alternatives considered

**Clear optimistically and restore on failure.** Rejected because restoration runs after later edits and attachment changes. It cannot distinguish the submitted prefix from new user intent without making the send snapshot the transaction owner in the first place.

**Keep the sink fire-and-forget and use a duplicate boolean.** Rejected because a sentinel does not own cancellation, reference fan-out, upload, Host admission, or teardown settlement. One retained attempt completion represents the operation and supplies the required quiescence boundary.

**Use one global lock for text and image-only sends.** Rejected because an unresolved image-only send need not block newly typed text, commands, or adjudication. Reserving only the captured image ids prevents duplicate attachment ownership while preserving independent valid input.

**Abort on release without awaiting completion.** Rejected because cancellation is cooperative. Serialization, browser file reads, or Host admission may settle after observing the signal; disposal cannot report quiescence while those owned promises remain live.

**Keep integer cache percentages and clamp incomplete hits to `99%`.** Rejected because it avoids the false `100%` label by discarding meaningful precision: `99.95%` and `99%` would become indistinguishable.

**Use a floating-point ratio, arbitrary-precision dependency, or unbounded decimal scaling.** Floating-point rounding caused the defect, a new numeric dependency is disproportionate for display formatting, and unbounded scaling can leave the safe-integer range. Quotient/remainder comparisons provide the needed exact ordering with bounded `number` arithmetic.

## Verification

Composer transaction tests pin duplicate suppression for ordinary Queue, Steer, slash-miss, and image-only paths; retry after outcome errors, rejections, and synchronous throws; suffix preservation; captured-image commit; image reservation across a concurrent text send; and protection of concurrent command and adjudication drafts. Lifecycle cases assert abort propagation, no late publication, serializer sibling cancellation, and disposal waiting for adjudication, serialization, and sink settlement.

Stats formatter tests pin ordinary integer rounding, several near-full decimal boundaries, exact full hit, and a one-token miss beside `Number.MAX_SAFE_INTEGER`. Component coverage confirms the minimum distinguishing precision reaches the rendered cache-hit label.

## Consequences

One owner now spans each accepted composer send from gesture to Host result, so duplicate suppression, retry, cancellation, and teardown refer to the same operation. New text and images survive according to explicit snapshot and reservation rules, while Queue and Steer behavior stays unchanged. Cooperative work that ignores abort can delay scope disposal because truthful quiescence is preferred over abandoning an owned promise.

Near-full cache hits may use long decimal labels in extreme safe-integer cases, while common values remain compact integers or short decimals. The display never uses `100%` as an approximation: that label is reserved for a mathematically complete cache hit.
