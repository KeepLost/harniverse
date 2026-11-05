# @deepseek-ai/dsh-compaction-body-limit-recovery

English | [中文](README.zh.md)

Recovery for requests the provider rejects at the transport body limit (`413 Failed to buffer the request body: length limit exceeded`, and equivalent body-cap signals on other providers): settle every still-active image occurrence, compact the text surface, then retry the request instead of surfacing the failure. Composed by the base bundle right after [`dsh-compaction-image-offload`](../compaction-image-offload/).

## What it does

The plugin hooks the `agent/request-error` waterfall. When the failure classifies as a request-body limit ([`REQUEST_BODY_TOO_LARGE_CODE`](../../llm/llm/README.md), mapped by the pi-ai stream classifier and both DeepSeek protocol adapters), the handler:

1. resolves image-offload decisions for the whole history with [`dsh-image-offload-policy`](../image-offload-policy/) at `{ setting: 'unlimited', pressureCount: Infinity }` — every still-active occurrence, oldest first — and appends one `image/offload` event carrying them;
2. calls `compactIfNeeded(agent, 'context-overflow', signal)` on the composed [`ctx.compaction`](../compaction/) engine, when one exists; a compaction failure is non-fatal (the image settlement is already durable);
3. retries when any deterministic reduction landed: settled decisions, a returned compaction result, or an advanced `replaceGeneration` (a compaction that threw mid-flight may still have appended events). Cancellation during recovery preserves the original failure.

The budget is three recoveries per session, reset on `assistant/message`; exhaustion surfaces the original error. Non-body-limit failures pass through untouched.

ponytail: this is a reactive loop — the ceiling is a transport cap discovered only by hitting it. The upgrade path is a proactive request-body budget (estimate the serialized request before send and pre-settle/pre-compact); until provider-specific size signals justify that design, the bounded reactive loop is the safety net.

```yaml
- id: compaction-body-limit-recovery
  name: '@deepseek-ai/dsh-compaction-body-limit-recovery'
```

## Model Experience

### Retried request, silently

#### What the model sees

Nothing of the recovery itself: the failed attempt does not enter the conversation surface. The retried request carries `image/offload` stubs where images used to be and, when compaction ran, the compacted surface — both are the standing mechanisms' ordinary outputs.

#### Token effect

The retried request is smaller: settled images become stubs and the shadowed range is summarized.

#### KV Cache effect

Reductions append or replace per the offload/compaction mechanisms' own contracts; the recovery adds no additional surface beyond them.

## Known Limitations and Deferred Work

- **Reactive, not proactive** — the first oversized request is still sent and rejected once; pre-send budgets are the deferred upgrade.
- **Three recoveries per session between assistant messages** — a genuinely irreducible body (one enormous live attachment outside the image vocabulary) exhausts the budget and surfaces the original error.
- **Compaction is best-effort on this path** — an engine-less composition still settles images and retries on that reduction alone.
