# Agent Note: Product subagent failure facts

Status: implemented

English | [中文](2026-08-24-product-subagent-failure-facts.zh.md)

## Problem

Claude Code and Codex one-shot providers flatten product, protocol, and process failures into shared non-completed results, but a stop reason alone cannot distinguish a product limit, permission denial, protocol close, or process exit. Copying native errors, stderr, prompts, paths, environment values, credentials, or protocol payloads into the parent model would expose untrusted and potentially secret data.

## Decision

`SubagentResult` has an optional provider-authored `diagnostic` for non-assistant failure detail. The shared out-of-process settlement path limits the complete value to 4096 UTF-8 bytes without splitting a code point and omits it when cancellation wins. Consumers keep the field separate from assistant `output`; the foreground delegation tool renders it under a `Diagnostic:` label before any partial assistant answer.

Each product failure starts with `Product subagent failure (product: <product>; stage: <stage>; category: <category>)`, extended only with validated HTTP status and independently observed process exit code or signal. The line is display text rather than a parseable protocol. Success and local cancellation omit it.

Claude Code maps only known SDK failure subtypes plus fixed invalid-success, missing-result, process-exit, and unknown categories. Its fixed unattended policy remains public-config-free: available SDK callbacks deny tool approval, decline MCP elicitation, and cancel supported blocking dialogs, while diagnostics record only the fixed request class and decision. Original errors remain available to Host `onError` through safe wrappers and causes.

Codex maps only fixed string and one-key object `codexErrorInfo` variants, accepts a numeric HTTP status only from recognized connection and stream variants, and treats malformed or future variants as unknown. The wire records fixed fail-closed request decisions and recognizes only the exact approval-denial and sandbox-violation stderr signatures, including across chunk boundaries. Raw stderr is forwarded to the Host but never retained in diagnostic text; JSON-RPC and process settlement remain terminal authorities.

## Verification

Behavior tests cover the shared multibyte limit, unchanged success and cancellation results, Claude SDK and process failures, Claude unattended decisions, Codex terminal categories and HTTP status, Codex request and stderr permission paths, process and protocol failures, max-token results, unsafe-data exclusion, and foreground diagnostic separation. A keyless assembled ACP snapshot pins foreground and background Claude Code and Codex diagnostic presentation. Focused TypeScript project builds cover the shared service, both product providers, and the foreground consumer.

## Alternatives considered

**Copy native error messages or stderr after redaction.** Redaction cannot enumerate every path, prompt, environment value, credential, or future protocol field, so diagnostics use fixed allowlists and independent process facts instead.

**Add configurable permission modes while porting diagnostics.** Harniverse already delegates product policy to native settings and exposes fixed unattended behavior; diagnostics do not justify a new public authority control.

**Encode a structured machine protocol in the string.** Consumers need bounded explanatory text, while stable machine fields would require a separately versioned typed contract.

## Consequences

Parent models receive actionable product provenance without receiving product payloads or secrets. Providers maintain explicit category allowlists and safe permission signatures as product protocols evolve, and Host logs retain richer original failures independently of model-facing text. The shared byte limit bounds every flattened provider diagnostic, including future providers that use the same settlement helper.
