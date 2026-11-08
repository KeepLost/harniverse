/**
 * Types for the shared PTC/SSH control-channel contract: frames, failure
 * kinds, channel limits, and the lifecycle states one long-lived execution
 * moves through. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-control-channel
 */
/** Defaults aligned with the fresh-process execution budget. */
export const DEFAULT_CONTROL_CHANNEL_LIMITS = {
    maxFrameBytes: 1 << 20,
    maxQueuedBytes: 4 << 20,
    maxPendingCalls: 64,
    closeGraceMs: 5_000,
};
//# sourceMappingURL=types.js.map