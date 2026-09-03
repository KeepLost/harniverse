# @deepseek-ai/dsh-compaction-settings

English | [中文](README.zh.md)

Registers the root-owned `compaction` Settings namespace. The optional `thresholdRatio` value overrides the automatic pressure threshold for every Agent Profile on its next compaction decision. When the value is absent, each Profile's compaction provider keeps its composed threshold.

Exact provider/model policies remain higher priority than this global override. The supported range is `0.17` through `1`; the lower bound stays above the default `0.16` retention ratio. A Profile whose ratio-based retention is at or above the global threshold keeps its own valid threshold instead of disabling compaction.

## Model Experience

### Global pressure threshold

#### What the model sees

The compaction provider may summarize older conversation history earlier or later according to `compaction.thresholdRatio`. This plugin contributes no prompt, tool, command, or model request itself.

#### Token effect

The setting changes the amount of conversation history retained in later requests and can move the cost of an auxiliary summarization request earlier or later; it does not add tokens directly.

#### KV Cache effect

Changing the threshold does not alter an in-flight decision. A later decision may compact earlier or later; only a committed compaction replacement changes the replayed prefix and invalidates reuse from its first replaced history token.

## Known Limitations and Deferred Work

- The setting controls only the pressure threshold. Profile-owned retention and exact model policies remain in the compaction provider configuration.
