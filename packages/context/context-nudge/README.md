# @deepseek-ai/dsh-context-nudge

English | [中文](README.zh.md)

Threshold-gated context-pressure notices over the non-waking [`agent.inject()`](../../core/agent/README.md) inbox. When a session's retained history crosses an absolute token threshold, the plugin queues one model-facing notice suggesting `context_compact`; growth past a configurable delta delivers the next one. Idle drivers leave the notice pending until the next user prompt or steering arrives, while a running driver claims it at its nearest step boundary — the notice never wakes a stopped agent.

The trigger is deliberately token-only. Huge-window models get proactive reclaim guidance; small-window models can never reach the threshold and stay on automatic pressure compaction and the human `/compact` command. Agents whose assembled tool catalog has no `context_compact` (for example the Code preset) receive no notices.

## Contract

- **First notice** fires when measured retained occupancy reaches `thresholdTokens`.
- **Spacing** requires growth of at least `refireDeltaTokens` since the last delivered notice.
- **Hysteresis** re-arms the first-notice rule once occupancy falls to `lastFireTokens − refireDeltaTokens` or below (typically through compaction).
- Measurement rides the shared token meter at durable surface boundaries (`user/message`, `assistant/message`, `tool/result`, committed `compaction/end`); the plugin's own pending notices are excluded so a delivery cannot re-trigger itself.
- Every notice records `measuredTokens` and `thresholdTokens` on its message source; the package invariant rejects any owned notice whose recorded measurement fell below its threshold.

Configuration comes from the plugin's composition config with live overrides through the `compaction` settings namespace (`nudgeEnabled`, `nudgeThresholdTokens`, `nudgeRefireDeltaTokens`, exposed on the Web settings compaction card). An invalid override — a delta not smaller than the threshold, or a non-positive value — is reported once and ignored in favor of the composition defaults.

## Composition

```yaml
- name: '@deepseek-ai/dsh-context-nudge'
  config:
    thresholdTokens: 120000
    refireDeltaTokens: 20000
```

Mount beside a composition that registers `context_compact` (the base composition does).

## Model Experience

### Context-pressure notice

#### What the model sees

A user-role system injection naming the current occupancy and pointing at `context_compact`. It arrives inside the next request that naturally follows — after the user's next prompt on an idle session, or at the next step boundary of a running one.

#### Token effect

Each notice costs its own short text. Notices are rare by construction: one per threshold crossing plus one per configured growth.

#### KV Cache effect

A claimed notice appends at the conversation tail; the prefix before it remains reusable.

## Known Limitations and Deferred Work

- **No provider-confirmed usage** — occupancy is the shared meter's estimate, not the provider's accounting; the two can drift by tokenizer.
- **Absolute thresholds only** — a window-relative threshold was rejected by design: the absolute threshold doubles as the model-class gate (see upstream Agent Note).
- **No per-agent overrides** — policy is global; per-profile tuning stays a composition concern until a consumer needs it.
