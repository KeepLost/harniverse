# Agent Note: Authenticated response envelope and cold composition reads

Status: implemented

English | [中文](2026-08-24-authenticated-response-envelope-and-cold-composition-reads.zh.md)

## Problem

Three operator-visible surfaces in the Web GUI reported failure instead of data: the settings Plugin section's Profile assembly and plugin inventory views, and the session Capabilities view. Two independent defects produced them.

The first defect broke every Typert Remote call carried over the client connection's HTTP request handler. `serverResponseSchema` requires an `authentication` field on `server-response`, and the browser half parses each response against that schema before delivering it. The handler built its envelopes without the field, so the admitted identity was present on the Host but absent on the wire, and the browser rejected well-formed successful responses as invalid input. The Host side was correct throughout: the same Remotes returned real data when called directly over HTTP, which is why the failure looked like a client bundle or composition problem rather than an envelope defect.

The second defect made an assembly result readable only while an Agent was live. `capabilityManagement.session()` resolved the composition from the running Agent and threw when none existed. A Session the operator opens from the sidebar is cold until it runs a turn, so the Capabilities view of any existing Session had no readable assembly — the state in which an operator most wants to inspect what was enabled.

## Decision

The HTTP request handler carries the admitted identity in every envelope it emits. It derives the principal identity once per request and writes it into the success, error, and invalid-envelope responses alike, so each response the handler can produce satisfies the schema the browser validates. The identity is the one already admitted for the request; the handler adds no new authentication decision, and the required capability of each Remote continues to gate the call.

`capabilityManagement.session()` reads a cold Session through the Profile its log recorded. A live Agent still answers from its own generation. Without one, the gateway resolves the Session's recorded `agentProfile` from session persistence and reads that preset's standing generation; a Session that persistence does not list is unknown and still fails loud. This follows the presenter-scope precedent in api-proxy: the standing mount composes plugins without resuming an agent, session, or turn, so the read stays observation-only.

`agentPresets` gains `standingCompositionRuntime(id?)`, the Agent-free counterpart of `compositionRuntime(agentCtx)`. It resolves the preset, ensures its standing mount, and returns the same generation identity and assembly entries that a joined Agent reports. Placing it on the preset roster keeps the composition knowledge with the owner of standing mounts rather than duplicating mount logic in the gateway.

## Scope

Both changes are read-path corrections. Neither alters Remote capability requirements, owner sealing, loopback-only bypass, TLS for non-loopback listeners, the set of public routes, durable session or Profile formats, or plugin selection state. The envelope change adds a field the schema already required; it introduces no new field and no new authentication outcome. The cold-composition change adds a read fallback and no mutation: composing a standing mount is the same effect an ordinary Profile read already has.

The archive panel and preview were already composed, and their earlier emptiness in probing was a fixture without archived Sessions. A separate reachability defect remained: the archive entry was rendered only in the expanded sidebar, so a collapsed or narrow sidebar had no route to the panel. The entry now renders in both sidebar states and expands the rail before opening the panel.

## Testing

The envelope defect is pinned where it originated and where it is consumed. The connection Host-half spec asserts the emitted envelope carries the identity and parses clean under `serverResponseSchema`, so a future envelope that drops the field fails at the schema the browser uses rather than only in a browser run. The api gateway Host spec pins the same field on its HTTP dispatch response.

The cold-composition path is covered by gateway unit tests for all three outcomes: a live Agent, a cold Session listed with a recorded Profile, and a Session persistence does not list. A cold Session whose log predates the recorded-Profile field resolves the default composition rather than failing.

The web e2e archive scenario extends the existing archive round trip: after the row-menu archive commits, the header entry opens the panel, the archived Session is listed rather than the empty state, and its preview resolves logged message content. The message assertion was falsified against a deliberately impossible expectation to confirm it observes five real rendered messages rather than passing vacuously.

The WorkspaceBrowser client spec covers the collapsed rail entry: the archive control is present, clicking it calls the shell's expansion action, and the control enters archive mode.

## Alternatives considered

**Relax `serverResponseSchema` to make `authentication` optional.** Rejected because the field is the response's record of which identity the Host admitted, and the browser validating it is the check working as designed. Weakening the schema would hide the defect on every channel instead of correcting the one producer that omitted the field.

**Have the browser tolerate a missing `authentication` field.** Rejected for the same reason, one layer later: a client-side allowance would let a Host emit under-specified envelopes indefinitely, and the two halves would disagree about what a response contains.

**Resume the Agent when the Capabilities view reads a cold Session.** Rejected because an observation-only read must not start a turn or attach an Agent. Resuming would make opening a Session's Capabilities view a lifecycle event with model, cost, and log consequences.

**Report an empty assembly for a cold Session.** Rejected because the composition is a fact the log records, not an absence. An empty result would misreport an assembled Profile as having no capabilities and would make the view useless in exactly the case it is opened for.

**Read the standing mount from inside the capability-management gateway.** Rejected because standing mounts belong to the preset roster. Duplicating the resolve-and-ensure sequence in a consumer would put two owners on one composition path and let them drift.

**Assert archive panel content from a unit-level fixture.** Rejected because the reported defect was about the assembled surface: entry, panel, and preview reached through the real wire. A component fixture would not have distinguished a composed-but-unreachable panel from a working one.

## Consequences

Every Typert Remote reaching the browser through the connection handler now works; the three reported surfaces render real data. The cost is that response construction has one more required input, which the tests now pin at both the producer and the schema.

The Capabilities view is readable for any listed Session, live or cold, and reading one composes that Profile's standing mount if it is not already mounted — the same effect any Profile read has, with no agent, session, or turn started. A Session absent from persistence still fails loud, so a genuinely unknown id is not silently answered with the default composition.

The web e2e lane and doc-sync carry pre-existing failures unrelated to these changes: golden aria snapshots drift on this environment, and `verify-export-jsdoc` and `verify-package-readme-model-experience` fail on files this change does not touch. They were confirmed byte-identical on a clean tree and are left for their owners.
