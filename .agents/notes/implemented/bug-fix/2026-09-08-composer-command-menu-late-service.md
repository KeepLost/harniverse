# Agent Note: The composer command-menu button stranded by a late slash service

Status: implemented

English | [中文](2026-09-08-composer-command-menu-late-service.zh.md)

## Problem

On a cold start (fresh tab, uncached bundles), opening the Web UI with a previous session restored left the composer's Commands button (`toggleCommandMenu`) permanently disabled: the textarea accepted input and typing `/` still opened the candidate menu, but the button never recovered — not after the late bundles finished loading, not on re-render, not on switching away and back to the session. A session created after load was unaffected, and a warm reload (F5) usually masked it.

## Root cause

Three facts compose into the defect:

1. Slot inject results cache per (entry × provide bundle) — `runInject` in `web-react` memoizes on the bundle object identity, and bundles are identity-stable until the provider roster moves.
2. The composer bar's inject resolves the optional `inputTriggers` service through the hub (`rootCtx.get`), so an inject evaluated before the `ui-input-trigger` client bundle loads bakes `toggleCommandMenu: undefined` into that cache cell.
3. Nothing invalidated the cell when the service arrived. The service was not on the session provide roster, so no roster change ever re-materialized the bundle; the same session id resolves the same bundle object on switch-back, so the stale inject result is served forever.

A first fix attempt registered the roster seat from the service constructor and still failed: vendored-Cordis `get` is strict — a service is invisible until its owning fiber is `ACTIVE`, and the constructor runs mid-startup. The seat must be registered after the plugin fiber is active for the re-resolved inject to see the service.

## Fix

`dsh-client-ui-input-trigger`'s `apply` holds a **member-less existence seat** on the session provide roster, registered inside its `ctx.inject(['slots', 'inputTriggers', 'sessions'], …)` callback (own fiber active, service strict-visible) and withdrawn on teardown. Registering or withdrawing the seat moves the roster, which re-materializes every live bundle and republishes `currentProvideInfo`; mounted session-maybe injects miss their cache cell and re-resolve against the now-visible service. The seat contributes no hooks or props — its only contract is that this service's arrival changes what other plugins' injects resolve.

Two regression tests pin the halves: `apply.client.spec.ts` asserts the seat's member-less registration and disposal on the plugin fiber's lifetime, and `scoped-slots.client.spec.tsx` asserts the render-side semantics — a session inject cached over an absent service re-runs and sees the late value when the bundle identity rotates (the roster-change replay).

## Verification

Reproduced on `master` with a real `dsh web` instance over the default home: repeated cold opens left the button disabled (`toggleCommandMenu === undefined` in the fiber, scope present, no block). With the fix, repeated cold opens resolve to an enabled button that opens the command menu; keyboard `/` behavior is unchanged. The repair lives entirely in the arriving plugin — no consumer-side cache-invalidation mechanism was added to `web-react` or `runtime`, which keeps the slot inject cache contract (identity-stable per bundle) intact.
