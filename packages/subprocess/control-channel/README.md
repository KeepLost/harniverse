# @deepseek-ai/dsh-control-channel

English | [中文](README.zh.md)

The shared bounded control-channel contract for PTC and SSH execution. One lifecycle owner — the fresh-process PTC provider or the SSH execution provider — consumes this seam; ordinary shell, LSP, and child-agent launches keep their simpler paths and gain no control protocol of their own.

The contract has three parts. The frame codec carries length-prefixed JSON `call`/`reply`/`log`/`limit`/`done` frames with a per-frame byte bound (oversized frames are refused, never split), incremental decoding that fails a peer declaring oversized or malformed frames, and an orthogonal failure vocabulary (`exception`, `timeout`, `abort`, `process-exit`, `invalid-output`, `output-limit`, `protocol`, `io`, `sandbox-unavailable`) so exactly one kind names the first terminal outcome. Backpressure applies where the decision is made: a send queue refuses writes above its queued-byte bound and a pending-call gate refuses calls above the reply bound. The lifecycle state machine separates result, cancellation, timeout, and channel closure — terminal categories never cross — then quiescence once the managed process range settles, then cleanup, which always completes and reports independently.

This package is contract-only. Transport attachment (fd or stream wiring), process supervision, and provider integration belong to the PTC and SSH providers that compose it.

## Model Experience

### Control channel frames

#### What the model sees

Nothing directly: frames carry tool calls, replies, and progress between the host and one controlled execution. A `log` frame's text may surface through a provider-owned progress channel; that wording belongs to the provider.

#### Token effect

None — the contract contributes no model requests.

#### KV Cache effect

None — the channel never touches request history.

## Known Limitations and Deferred Work

- Transport wiring (stdio control fd, SSH stream), deadline ownership, and process-range supervision belong to the PTC and SSH providers.
- Frame compression and multiplexing several executions over one channel are out of scope until a provider needs them.
