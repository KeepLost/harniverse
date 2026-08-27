# Agent Note: Session-indexed LLM wire-attempt diagnostics

Status: implemented

English | [中文](2026-08-27-llm-wire-attempt-diagnostics.zh.md)

## Problem

The Session log preserves the conversation, request header snapshots, normalized stream chunks, and final failures, but it does not identify the adapter parameters and provider response facts for one actual network attempt. A provider or gateway failure could therefore be observed in the transcript without proving which transport attempt produced it.

## Decision

The LLM seam defines runtime-only wire callback fields on `GenerateOptions`. The agent loop supplies one exchange id and appends one `llm/wire-attempt` event for every adapter attempt, citing the request header sequence, route-context sequence, history cut, turn, and step. The event stores protocol, provider, model, endpoint, method, request byte size, a canonical non-secret fingerprint, non-context request parameters, selected diagnostic response headers, status, duration, outcome, and normalized failure facts.

The two shipped network adapters report at their transport boundaries. The pi-ai adapter uses its final payload callback and recovers HTTP status and provider message from SDK status-line errors when pi-ai does not expose an HTTP response callback. The direct DeepSeek adapter records each fetch, including its internal stale-file fallback request.

The event deliberately does not retain complete request or response bodies. Conversation messages, system text, and tools remain solely in the append-only Session log. Replay combines the cited Session state with the wire parameters and compares the regenerated request fingerprint before comparing provider status and error facts.

Fingerprints are canonicalized for object-key order and are not credential hashes. Credential-bearing request keys are excluded from the retained parameter projection. Response headers are reduced to status, request/rate-limit, content, server, and timing-related diagnostics.

## Consequences

Every agent-backed network attempt adds one small log event and performs one lightweight in-process fingerprint. Successful and failed requests use the same request-side record shape; failures add only their normalized outcome facts. Normal assistant output remains represented by existing `assistant/chunk` and `assistant/message` events, so the feature does not duplicate streamed responses or conversation history.

The current callback is runtime-only and has no effect on independently hand-built LLM calls that do not provide an observer. A process crash before an adapter reports an attempt leaves no wire event for that in-flight call; crash-complete network capture is outside this decision.

## Alternatives considered

Persisting complete request and response bodies was rejected because the Session log already owns the conversation and successful response content, while the requested replay target is provider status and error. A separate network log without Session sequence references was rejected because it would duplicate context and leave the exact history point ambiguous. Capturing only failed requests was rejected because it creates asymmetric behavior and makes successful-to-failed comparisons less reliable.
