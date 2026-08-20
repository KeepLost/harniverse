# @deepseek-ai/dsh-tool-session-delivery

English | [中文](README.zh.md)

Default `session_send_message` and `session_unload` Consumer over `ctx.sessionDelivery`. It requires a calling Agent, targets ordinary session ids, returns accepted message ids immediately without waiting for replies, and unloads only safe idle targets.

## Model Experience

### Delivery and unload tools

#### What the model sees

The generated [`session_send_message` and `session_unload` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-delivery) deliver a later turn or unload an idle target. Delivery success explicitly does not imply completion or a reply; unload refuses targets with active, queued, subagent, or runtime-owned work.

#### Token effect

Two fixed schemas and one short acknowledgement per call; target output is queried separately.

#### KV Cache effect

The acknowledgement appends to the caller; the delivered message separately appends to the target.

## Known Limitations and Deferred Work

- The tool does not wait for, collect, or causally identify a target reply.
