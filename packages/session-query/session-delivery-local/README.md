# @deepseek-ai/dsh-session-delivery-local

English | [中文](README.zh.md)

Local Provider for `ctx.sessionDelivery`. It creates ordinary sessions with the deployment default model and Profile mounted before publication, reuses a live ordinary Agent or single-flight resumes a persisted ordinary session under its recorded model and preset, and unloads only idle ordinary sessions with no queued or runtime-owned work. Ordinary delivery calls `Agent.followup()`; direct-child delivery delegates to `ctx.subagents.followup()` so parent authorization, Activation routing, and cold recovery remain authoritative. Neither route waits for the target turn.

## Model Experience

Indirectly, through `dsh-tool-session-delivery`, which renders acceptance or failure.

#### KV Cache effect

Accepted messages append to the target session later.

## Known Limitations and Deferred Work

- Delivery is process-local; there is no cross-process activation lease.
- Acceptance precedes write-behind persistence and therefore is not a crash-durability barrier.
