# Supervision

English | [中文](supervision.zh.md)

The supervision subsystem owns the per-session policy for human-dependent operations. `supervised` permits configured question and approval providers; `unsupervised` rejects new requests that would wait for a human and exposes the remaining decision in the model-facing runtime context.

The effective mode is a durable `supervision/mode` event. The service pins a deployment fallback for sessions without one, resolves the last event for each session, and records changes through `/supervision <mode>` or the client projection. Child Profiles capture an explicit mode or inherit the parent's mode without allowing an unsupervised parent to escalate a child.

The [package README](../../packages/interaction/supervision/README.md) owns composition status, provider limitations, and model-experience detail. The [persistence catalog](../persistence-catalog.md) owns the complete event declaration.

Source: [`packages/interaction/supervision/src/index.ts`](../../packages/interaction/supervision/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsupervision--supervisionservice"></a>

### `ctx.supervision` — `SupervisionService`

Service owning the durable supervision mode and its model-facing context.

```ts cordis-catalog
/** Resolve a session's current mode from its durable event log.
 * @param session - session whose effective mode should be resolved.
 * @returns the session mode or the deployment fallback.
 */
modeOf(session: Session): SupervisionMode

/** Whether a human-dependent operation may enter an answerer/provider.
 * @param session - session to evaluate, or undefined for the deployment fallback.
 * @returns whether human interaction is allowed.
 */
allowsHumanInteraction(session?: Session): boolean

/** Switch a live session and make the new policy visible on its next step.
 * @param session - live session whose mode should change.
 * @param mode - new supervision mode.
 */
set(session: Session, mode: SupervisionMode): void
```

Types: [Session](session.md)

Source: [`packages/interaction/supervision/src/index.ts:76`](../../packages/interaction/supervision/src/index.ts)
<!-- END GENERATED cordis-surface -->
