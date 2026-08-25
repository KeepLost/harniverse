# @deepseek-ai/dsh-tool-session-delivery

English | [中文](README.zh.md)

Default `session_create`, `session_message`/`session_send_message`, and `session_unload` Consumer over `ctx.sessionDelivery`. It requires a calling Agent, creates a persistent session in the caller's workspace, targets ordinary session ids, returns accepted message ids immediately without waiting for replies, and unloads only safe idle targets.

## Model Experience

### Delivery and unload tools

#### What the model sees

The generated [`session_create`, `session_message`, `session_send_message`, and `session_unload` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-delivery) create a persistent session, deliver a later turn, or unload an idle target. Creation returns only after Profile/model setup is attached; delivery does not imply completion or a reply; unload refuses targets with active, queued, subagent, or runtime-owned work.

#### Token effect

Four fixed schemas and one short acknowledgement per call; target output is queried separately.

#### KV Cache effect

The acknowledgement appends to the caller; the delivered message separately appends to the target.

## Known Limitations and Deferred Work

- The tool does not wait for, collect, or causally identify a target reply.
