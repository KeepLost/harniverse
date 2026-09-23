# Agent Note: The CDP launch endpoint matched a half-delivered stderr line

Status: implemented

English | [中文](2026-09-23-cdp-endpoint-truncation.zh.md)

## Problem

On machines with a real `google-chrome`/`chromium` installed, the browser panel failed to open with `DevTool endpoint ws://… refused the connection` even though Chrome itself was healthy. The launch path in `packages/api/browser-controller/src/launch.ts` scrapes the child's stderr for the `DevTools listening on ws://…` line and hands the captured URL to a WebSocket. Stderr arrives in chunks, and when a chunk boundary fell inside the endpoint line the scraper still declared a match: in JavaScript the `m`-flagged `$` also matches the end of the *input*, not only the end of a line, so a half-delivered URL looked complete to the regular expression. The URL's trailing GUID is the browser's own session id, so a truncated id named a target that does not exist and Chrome refused the handshake — the error the user saw, verbatim.

## Decision

Anchor the match on an actual line break: `ENDPOINT_PATTERN` now requires `\r?\n` after the captured URL, so the endpoint is only adopted once the whole line has arrived. A chunk split inside the line simply leaves the pattern unmatched until the next chunk completes it. `packages/api/browser-controller/tests/fake-browser.ts` grew a `splitEndpointTail` knob that splits the endpoint line into two writes at a byte offset, and its WebSocket server now routes by path (`/devtools/browser/fake`) and rejects unknown paths exactly like a real Chrome, which is what makes the failure observable before the fix. The regression case `waits for the whole endpoint line when the stream delivers it in two reads` reproduces the user's exact error against the unfixed pattern and passes with it.

## Alternatives considered

Requiring `--remote-allow-origins` on the Chrome command line was the first hypothesis and is irrelevant here: Node's global `WebSocket` sends no `Origin` header, so the Chrome 111+ origin check never triggers. Enriching the refused-connection error with the underlying cause was the second and is inert: the platform reports an empty `ErrorEvent.message` both for a refused connection and for a nonexistent path, so there is nothing to surface.

## Consequences

Launch is robust against arbitrary chunk boundaries on the endpoint line, with no behavior change for the fully-delivered case. The fake browser's path routing also hardens every other launch test against accepting endpoints that a real Chrome would reject.

## Testing

`NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/vitest run packages/api/browser-controller/tests --maxWorkers=1 --no-file-parallelism` — 104 tests including the new two-reads regression.
