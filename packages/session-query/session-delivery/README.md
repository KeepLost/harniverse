# @deepseek-ai/dsh-session-delivery

English | [中文](README.zh.md)

Provider-neutral `ctx.sessionDelivery` Definition for delivering one user-role message to another ordinary session as a later FIFO turn and safely unloading idle ordinary sessions. Delivery success means inbox acceptance only; it never means the target replied or completed work.

## Model Experience

None, as this Definition registers no prompt, tool, or model-visible content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The contract acknowledges process-local inbox acceptance, not crash durability or completion.
