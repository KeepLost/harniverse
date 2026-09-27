# Agent Note: Bundle-declared home ownership before profile boot

Status: implemented

English | [中文](2026-09-27-profile-home-ownership.zh.md)

## Problem

Profile preparation writes the Harness home before any Web authentication plugin mounts. The network-instance lease therefore cannot prevent a concurrent profile process from changing shared profile files or session state, and a one-shot profile has no network lease at all.

## Decision

`dsh` uses `loadProfile` read-only to inspect the existing manifest or a missing profile's shipped template before preparation. A nonempty bundle list is shared only when every resolved bundle declares `dsh.bundle.homeOwnership: "shared"`; every other composition requires the canonical home's process-lifetime `runtime/instance.lease`. The auth bundle declares sharing so its registry-coordinated management operations remain available while Web owns the home, including first-owner approval for remote bootstrap. The launcher does not branch on profile names.

Every invocation also acquires a separate `runtime/profile-<encoded-name>.lease` before writing its profile files. Shared invocations skip global module-fallback repair and resolve bare plugin names through the installation anchor. Shutdown, fatal Loader rejection, and failed startup release leases only after tree disposal settles. A failed or timed-out tree drain keeps ownership until process exit; a later invocation can reclaim a dead owner's lease. Release unlinks only its nonce-specific owner record and tolerates `ENOTEMPTY`, `ENOENT`, or `EPERM` when removing the vacated directory, preserving a successor that arrives between those operations. The authentication plugin retains its narrower network-instance lease and browser authentication rules.

## Alternatives considered

- Acquiring the existing authentication lease earlier: rejected because it belongs to a Web authentication provider and cannot cover headless profiles or writes performed before the provider mounts.
- Using the Web listening port as the exclusion mechanism: rejected because two processes can select different ports while writing the same home.
- Exempting the auth profile by name: rejected because renamed profiles and third-party management bundles require the same policy, and a customized auth composition can contain exclusive bundles.
- Allowing concurrent runs of one shared profile without a profile lease: rejected because profile initialization, root rewrites, and Loader write-back share those files even when provider writes coordinate independently.

## Consequences

Concurrent exclusive profiles require distinct `DSH_HOME` values. Shared bundles promise that their providers and any user-added patches are safe beside the home owner; the declaration is not a concurrency sandbox. Bare plugins in shared profiles must resolve from the installed host. `dsh plugin` and offline configuration dumps are not profile runs and do not acquire these leases.

Focused tests cover read-only metadata inspection, conservative defaults, contention, canonical aliases, dead-owner recovery, successor-safe release, failed-startup cleanup, and ownership throughout tree draining or teardown failure. Real source-entry subprocesses exercise auth list/help under a held home lease, a renamed shared profile, same-profile refusal, and Web/headless or mixed-composition refusal before profile writes. The paired contracts are [app-boot](../../../../packages/boot/app-boot/README.md), [CLI reference](../../../../apps/cli/reference/README.md), and [auth-app](../../../../packages/bundle/auth-app/README.md), each with its sibling Chinese counterpart and named pairing record. Windows filesystem behavior and full repository coverage require their CI runners; the focused Linux checks do not establish either.
