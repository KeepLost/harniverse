# Agent Note: PTC runtime naming and Electron child bootstrap

Status: implemented

English | [中文](2026-09-23-ptc-runtime-naming-and-bootstrap.zh.md)

## Problem

Product copy, package names, and the runtime service use different names for programmatic tool calling. That makes the capability's Definition, Providers, and Consumers harder to identify. A pre-release rename can align those names without introducing compatibility aliases.

The Node provider launches a fresh child with no inherited host environment. Under Electron, `process.execPath` identifies Electron: invoking it without the Node bootstrap switch starts the application instead of the program runtime. Inheriting the host environment would also expose credentials to model programs.

## Decision

PTC names the product presentation and the capability family. [`ptc-runtime`](../../../../packages/ptc-runtime/ptc-runtime/README.md) defines `PtcRuntime` at `ctx.ptcRuntime`; [`ptc-runtime-node`](../../../../packages/ptc-runtime/ptc-runtime-node/README.md) and [`ptc-runtime-python`](../../../../packages/ptc-runtime/ptc-runtime-python/README.md) provide the service. The tools registry remains its Consumer. Durable preset identifiers such as `code`, the `run_code` tool, and dispatch event names retain their identity. Active source, configuration, package metadata, and generated catalogs use the new names without aliases.

The Node provider supplies `ELECTRON_RUN_AS_NODE=1` only when launching the Electron host's own executable. A separately configured Node executable receives no Electron switch. Source and built entries receive their heap cap through argv. Packaged self execution retains its routing marker and `NODE_OPTIONS` heap cap; an explicit Node/bootstrap pair uses the installed entry instead of packaged routing. The child entry removes all three bootstrap variables before it executes model code.

Nested runtime calls made by host bindings create independent children with independent control channels and budgets. Model-created subprocesses see the cleaned environment; they must choose Electron's Node mode explicitly if they reuse an Electron executable. The provider's confinement, output limits, deadlines, and quiescent cleanup retain their existing owners.

This note owns naming and executable bootstrap. The historical [presentation foundation](../feature/2026-06-15-code-mode.md) still explains registry ownership and the SDK dispatch boundary; its wider decision is only partially superseded.

## Alternatives considered

**Compatibility aliases for the old runtime names.** Rejected under the pre-release contract: aliases keep two public names for one service and make configuration errors survive the rename.

**Inherit the host environment.** Rejected because Electron needs one bootstrap switch, while the ambient environment can contain provider credentials and application state. The provider constructs the required environment explicitly and the entry removes bootstrap-only values.

**Always require a separate Node installation.** Rejected as the default because Electron can run the installed child itself when its `runAsNode` fuse is enabled. Explicit Node and bootstrap paths remain the deployment alternative when that fuse is disabled.

## Consequences

Deployments must use the renamed packages and `ptcRuntime` service; stored preset and tool identities remain stable. Electron distributions must keep `runAsNode` enabled or configure a genuine Node executable and child entry. Child programs retain bash-equivalent trust; environment cleanup does not create a security sandbox.

Spawn-plan regressions distinguish ordinary Node, Electron self execution, explicit Node, and packaged routing. Source and built child execution checks prove bootstrap variables and ambient test secrets are absent from model code; nested execution checks prove distinct processes and output. A stubbed Electron version exercises selection under Node, so an actual Electron distribution and packaged executable still need their distribution-level launch checks.
