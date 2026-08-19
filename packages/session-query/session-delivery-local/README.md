# @deepseek-ai/dsh-session-delivery-local

English | [中文](README.zh.md)

Local Provider for `ctx.sessionDelivery`. It reuses a live ordinary Agent or single-flight resumes a persisted ordinary session under its recorded model and preset, falling back to an optional deployment default model when the session has no request history. A blank cold session is rejected when neither source exists. It rejects self and subagent targets, calls `Agent.followup()` without awaiting the target turn, and unloads only idle ordinary sessions with no queued or runtime-owned work.

## Model Experience

Indirectly, through `dsh-tool-session-delivery`, which renders acceptance or failure.

#### KV Cache effect

Accepted messages append to the target session later.

## Known Limitations and Deferred Work

- Delivery is process-local; there is no cross-process activation lease.
- Acceptance precedes write-behind persistence and therefore is not a crash-durability barrier.
