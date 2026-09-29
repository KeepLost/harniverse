# Agent Note: Connectivity testing replaces host-key entry for remote hosts

Status: implemented

English | [中文](2026-09-27-remote-host-connectivity-test.zh.md)

## Problem

Adding an SSH-managed remote host required the operator to type a canonical OpenSSH `SHA256:<43-character base64>` fingerprint before a host could be saved. The coordinator already offered an unauthenticated probe, so the field was mechanically fillable, but the trust step it represented was not: the UI asked the operator to obtain an independent verification of an observed key, and for most hosts no second channel exists. The realistic outcome was that the operator copied the probe's own suggestion back into the field, which made the recorded pin the same untrusted observation it was supposed to corroborate.

The same form asked the operator to declare the remote `platform` and `architecture` before connecting. Those values select the local artifact directory whose manifest is verified against its own `node.platform`/`node.arch`, so they must be known before deployment — but they are properties of the target that the target can report, and the coordinator already re-checks them after connecting through the runtime status response.

## Decision

A host is saved only after a connectivity test passes. The test is a real authenticated connection, and the fingerprint it records is a byproduct of that connection rather than an operator input.

`RemoteHostSshProvider.probe` becomes `verify(config, authentication, command, signal?)`. It accepts this attempt's host key instead of comparing it to a pin, authenticates with the supplied credentials, and runs `command` only after authentication completes, returning `{ fingerprint, output }`. The observed fingerprint is trustworthy precisely because a successful authentication followed it under that same key; a transport-level helper returns the evidence rather than leaving it to a caller that cannot prove the same ordering.

`RemoteHostsProvider.verify({ host, port?, username, secrets })` owns the test's meaning. It runs a fixed detection command through the SSH provider and maps the answer onto a deployable target, returning `{ fingerprint, platform, architecture }`. Detection asks the POSIX form first (`uname -s`, `uname -m`) and retries through encoded PowerShell for a Windows default shell, because the target's shell is itself unknown at that point. An answer naming no supported platform or architecture fails the test with `UNSUPPORTED_REMOTE_PLATFORM`.

`upsert` keeps requiring `fingerprint`, `platform`, and `architecture`, so "test before save" is enforced by the existing schema rather than by new server-side state. The view holds the completed evidence and gates its save control on it. Platform and architecture default to decide-at-connect: the editor keeps them behind a collapsed optional section, and saving resolves them from the tested evidence unless the operator pinned explicit values. Any edit to the tested address, port, user, or credential invalidates it.

Artifact inspection failures at connect name their cause instead of flattening to `CONNECT_FAILED`: a selected artifact directory that does not exist reports `ARTIFACT_NOT_FOUND`, one that exists but fails inspection reports `INVALID_ARTIFACT`, both over the carrier's closed reason channel; the host logs the swallowed cause's error name and code — never its message — so operator copy stays on the actionable reason.

## Alternatives considered

- Keeping the manual field and adding a first-use acceptance button: rejected because two ways to trust a key leave the strict one looking authoritative while the lenient one is what operators would actually use, and the form would still ask an operator to type a value the system observed.
- Keeping `probe` as an unauthenticated observation and adding `verify` beside it: rejected because nothing would consume the observation once the manual field is gone, and the repository rule against abstractions without a current owner applies. The rejecting-probe behavior has no remaining caller.
- Enforcing "tested" as server-side coordinator state: rejected because validity depends on form fields the coordinator never sees (an unsubmitted draft's target and credentials), so the rule would need server-side session state, expiry, and interaction with the disconnect-before-edit guard, to restrain only callers that already hold `harniverse.administer`. The hard enforcement that matters is unchanged and remains where it belongs: `hostVerifier` compares the stored pin on every connection.
- Detecting the platform from the remote runtime's `status` response: rejected because the artifact must be chosen before the remote runtime is deployed, so detection cannot depend on it; `status` keeps its role as the post-deploy mismatch check.
- Parsing `uname` alone: rejected because a Windows default shell exposes no POSIX `uname`, and the probe cannot know which shell will answer.
- Treating the detected platform as authoritative: rejected because detection covers the artifact matrix, not every legitimate target; the operator keeps an override and the deploy-time check still rejects a wrong choice.

## Consequences

The recorded pin's trust root becomes first-contact acceptance under a successful authentication: the same key was used for a real login, and any later change fails `HOST_KEY_MISMATCH` against the stored value. This is weaker in principle than an out-of-band verified fingerprint and stronger in practice than a form that asked for one and received a copy of the probe's own answer. A host-key change surfaces as a failed connectivity test with no stored acceptance to fall back on.

`verify` requires credentials for a host that may never be saved, so it accepts one-shot secrets in the request and never persists them; saved credentials are re-verified by a fresh test rather than trusted from the registry. The provider deletes the `authHandler: []` rejection path, so `RemoteHostSshProvider` can no longer observe a key without authenticating.

The detected platform is a default, not a guarantee. `ENDPOINT_IDENTITY_MISMATCH` remains the last check, and a target whose `uname` is unreliable needs an explicit override.

Verification lives in the SSH provider suites (authenticated first-contact test, rejection without a probe command), `detect.spec.ts` (POSIX and Windows answers, unsupported answers, probe ordering), the coordinator suite (test evidence, sanitized failure), and the browser view suite (save gated on a passing test, invalidation on every tested field, decide-at-connect resolution of the detected values, stale evidence dropped after a failed retest). Real remote verification still requires a configured remote host.
