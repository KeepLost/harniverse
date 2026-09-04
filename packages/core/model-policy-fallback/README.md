# @deepseek-ai/dsh-model-policy-fallback

English | [中文](README.zh.md)

Executes cross-model fallback for a Session's selected Model Route. The existing `dsh-llm-retry` listener remains responsible for retries on one concrete provider/model. This plugin delegates to that listener first, then advances the ordered Route only when same-model recovery does not claim the failure.

Each transition is written as `model/fallback` before the next request is started. The following `agent/request` waterfall reconstructs the transition from the Session log, so a retry or resume does not depend on process-local route state. Cancellation never advances a Route.

## Model Experience

### Cross-model fallback

#### What the model sees

The next attempt keeps the existing conversation and tool context.

##### Replacement request

```markdown
The same derived Session history and tools are sent to the next concrete model target in the configured Route.
```

#### Token effect

No additional prompt content is added.

##### Token accounting

```markdown
A failed attempt may consume provider tokens before the next target is tried.
```

#### KV Cache effect

Switching provider or model normally loses provider-side KV cache reuse.

##### Cache continuity

```markdown
The Session transcript remains unchanged and is rebuilt for the replacement target.
```

## Known Limitations and Deferred Work

- The route advances for every non-cancellation normalized LLM failure; provider policy and deployment configuration remain responsible for choosing an appropriate ordered chain.
- A Route is exhausted for the current step after its last concrete target; the original terminal failure is then reported by the Agent loop.
