# @deepseek-ai/dsh-image-offload-policy

English | [中文](README.zh.md)

The contract for age-based image offload. It owns the global `imageOffloadAfterUserTurns` setting shape (`'unlimited'`, the default, or a positive integer), the pure decision rules that choose which image occurrences unload at one request-assembly point, the durable `image/offload` session event those decisions are appended as, and the canonical offload stub text the model sees in place of an offloaded image.

Aging counts later `user/message` events per image occurrence — assistant messages, tool traffic, and context snapshots never increment it. With a limit of four, an image unloads when the fourth later user turn is assembled, unless provider pressure or compaction has already handled it; an occurrence already recorded by an earlier `image/offload`, or whose carrying event a compaction replacement shadowed, is finished and is never chosen again. The original attachment stays retained for replay and authorized re-reads; nothing here deletes attachment bytes.

This package is contract-only. The compaction and request projection that applies these decisions — including stub rendering and provider pressure signals — composes this package and ships with the image-offload runtime.

Same-message replacements with `surfaceOp: replace` and source provenance carry surviving images' existing ages forward. Provenance on an appended message does not retire its sources. An explicit authorized re-read creates a new message occurrence and starts at age zero, even when its attachment hash matches an older offloaded occurrence.

## Model Experience

### Image offload decisions

#### What the model sees

After an `image/offload` decision is appended, later requests render the canonical `OFFLOADED_IMAGE_STUB_TEXT` line in place of each offloaded image. The stub states that the original attachment is retained outside the current request and that the image must not be treated as visible. This plugin contributes no prompt, tool, or request of its own.

#### Token effect

Each offloaded image removes its image tokens from later requests. The stub text itself adds a fixed one-line cost per offloaded image.

#### KV Cache effect

An offload changes the request at the image's position, so prefix reuse ends at the first offloaded image. This is a consequence of the unload, not a delay the policy may impose: reaching the configured user-turn age always offloads immediately, and cache reuse never postpones it.

## Known Limitations and Deferred Work

- The package decides, it does not project: applying decisions to model requests, wiring provider pressure signals, and the settings UI belong to the image-offload runtime that composes this contract.
- Compaction replacements without `sourceEventSeqs` cite nothing and therefore settle no occurrences; the projection treats their coverage as unattributable.
