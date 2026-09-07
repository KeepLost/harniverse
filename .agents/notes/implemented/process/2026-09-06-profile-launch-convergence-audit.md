# Agent Note: Profile-launch convergence audit — dispositions for the four remaining gaps

Status: implemented

English | [中文](2026-09-06-profile-launch-convergence-audit.zh.md)

## Problem

The wave-2 A8 decision bounded the profile-launch convergence to four remaining gaps: named profile composition selection (replacing the file-path `command`+`args` form), load-time validation, the same-version-launcher constraint, and retiring the old SDK demo examples. Before implementing, this audit had to establish how those gaps map onto Harniverse's actual launch infrastructure — the profile track (`$DSH_HOME/profiles/<name>`, bundle patch layers, `dsh --profile`) and the SDK child track (a stdio JSON-RPC runtime bin composed through an explicit `--config` include tree).

## Decision

All four gaps are dispositioned with no code change; each disposition rests on a structural fact verified against source:

- **Named profile composition selection — deferred with a concrete trigger.** The two tracks are separate by design: the profile track serves the `dsh` CLI surfaces (web/headless/auth app plugins reading `ctx.cmdlineArgs`), and no profile-composable stdio JSON-RPC server surface exists — `dsh-jsonrpc-agent` lives only as the `dsh-jsonrpc-demo` bin with its `--config` include root (`boot(binName, absoluteConfigPath)` mounts one file; `loadProfile`+`composeEntries` is the layer-stacked track, and `DSH_PROFILE` appears nowhere in the tree). Bridging them means inventing a profile-composable server surface first — an infrastructure gap, not a config-key rename, and out of the A8 "bounded convergence" scope. The current explicit form already carries the property the official change wants: the composition source is unambiguous (an explicit bin plus an explicit config path, or `DSH_CORDIS_CONFIG` in the explicit child env). Trigger for reopening: an SDK deployment needs multi-profile reuse or installation-level composition management — then profile-ize the server surface first, and add `Config.profile` as a thin name over it.
- **Load-time validation — already present in the load-bearing fields.** `cwd` validates once at load against the launch directory (`validateConfiguredCwd`), `maxTokens` and every timeout bound validate at load, and a misconfigured directory fails before any spawn. `command` deliberately does not resolve at load: it names a PATH executable or a packaged-exe path whose validity is a runtime property of the deployment, and the spawn's failure diagnostic already names the command. The profile field that would have carried existence validation does not exist yet (previous bullet).
- **Same-version-launcher constraint — achieved by explicitness.** The child is spawned from the configured `command`, which in every in-tree composition is a path inside the same installation (`node … packages/examples/jsonrpc-demo/…`); the parent never guesses a launcher, so no implicit-version drift path exists. A packaged exe is pinned to itself by construction.
- **Demo retirement — not applicable.** Unlike upstream's SDK-usage demos, `packages/examples/acp-demo` and `dsh-jsonrpc-demo` are the live transport test bases: the ACP snapshot/e2e suites, `jsonrpc-agent` smoke suites, and `subagent-acp`/`subagent-dsh-sdk` compositions boot these bins directly. Deleting them would dismantle the transport test surface rather than remove a stale example; SDK usage documentation already lives in `packages/sdk/client`. The third package, `agent-spine-demo`, is the composition spine those apps build on and stays.

Additionally, the environment-assembly uniqueness the A8 goal statement demands was re-verified: child-process environment assembly has exactly two exits, both built on the same `scrubbedParentEnv()` (which internally overlays `proxyEnvironmentForChild`) — the `dsh-subprocess` seam's spawn path, and the SDK client spawn's documented exception (`run.ts` applying the scrub itself because the SDK client, not `ctx.subprocess`, owns the spawn). The parent process's own egress goes through the single `installProxyFromEnvironment` install point in profile boot.

## Alternatives considered

**Implement `Config.profile` now as a name that resolves through `resolveProfileDir` and stamps `DSH_PROFILE` into the child env.** Rejected: without a profile-composable server surface on the child track, the name would resolve to a directory no SDK child can boot from — a config key that implies a guarantee the tree cannot honor.

**Retire the demos and rebuild thin `sdk-app`/`sdk-minimal` examples.** Rejected: the demos' role here is test infrastructure, not SDK pedagogy; a replacement example would not restore the snapshot compositions the transport suites boot.

## Consequences

A8 closes with the convergence claim sharpened rather than a config surface added: the existing `ResolvedChildProfile` handshake (profile id, revision, digest, model route, tools crossing the delegation boundary immutably) remains the substance of profile-launch convergence, and the four residual gaps are recorded as already-met, structural, or deferred-with-trigger. No plugin, bundle, or composition changes, so no ledger row. Evidence: source citations in each bullet (`boot` signature and `DSH_PROFILE` absence, `validateConfiguredCwd` at load, `scrubbedParentEnv` call sites in `subprocess-local/src/spawn.ts`, `subagent-dsh-sdk/src/run.ts`, `subagent-claude-code/src/{run,process}.ts`, `installProxyFromEnvironment` in `apps/cli/src/profile-boot.ts`); demo test-dependency references enumerated across `examples/acp-agent` and `examples/jsonrpc-agent` suites.
