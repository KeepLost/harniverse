# Agent Note: VM M8 — egress honesty: approval cards and the guest-visible proxy

Status: implemented

English | [中文](2026-11-06-vm-m8-egress-approval.zh.md)

Date: 2026-11-06. Scope: the egress approval chain for the vm world (`packages/vm/subprocess-vm`), the origin seam (`packages/vm/vm`), the guest SOCKS5 proxy and protocol ops (`packages/vm/vm-qemu-local`), and the vm row's egress mode in `dsh-base`. The `dsh-subprocess` contract and every consumer compose unchanged.

## Problem

The world's egress relay existed since M2 as a host-side constructor callback (`openWorld({ egressPolicy })`) that no product composition could reach: the plugin `Config` had no such field, so every dial in a deployed world denied — honest, but unusable, and the guest had no way to dial at all (no network device, no proxy op). The roadmap's M8 asked for three things: a config-borne approval source, an approval card through the existing cordis user-questions infrastructure, and a guest-visible socket proxy riding the M5-era data-plane lessons.

## Decision

**Session affinity by ambient initiator capture, not contract threading.** `ctx.userQuestions.ask` demands the exact live `Agent` (its `CALLER_NOT_LIVE` gate), so an approval card can only name a session that is alive when the dial happens. Rather than widen the `dsh-subprocess` contract with an agent field every tool would have to thread, `subprocess-vm` captures `ctx.agents.currentInitiator()` — the AsyncLocalStorage initiator boundary agent-loop already establishes — at spawn entry. A spawn with no live initiator gets no origin and its dials deny (there is no one to ask); a spawn with one mints `vm-exec-<n>` and registers an approver under it via the new `VmWorld.registerEgressOrigin` seam (dsh-vm; default no-op, so worlds without an egress surface accept and never consult). The binding releases when the spawn exits or the provider disposes.

**The guest-visible proxy is SOCKS5 on the guest loopback, not a new device.** Protocol v3 grows the surface additively (no version bump, mirroring M7's caps precedent): `exec` may carry `origin`; the guest agent binds a per-origin SOCKS5 listener on 127.0.0.1 (PID 1 now brings `lo` up itself via SIOCSIFFLAGS), injects `ALL_PROXY`/`all_proxy` (`socks5h://127.0.0.1:<port>`) into the child env, and speaks the minimal handshake (no auth, CONNECT only, IPv4/domain/IPv6 targets). Stock curl, wget, and git honor the env unmodified. Each CONNECT asks the host (`egress.open {id, host, port, origin}`); the host's `GuestEgressBridge` routes it through `WorldEgress`, which consults the origin's approver, then answers `egress.opened`/`egress.denied` and streams base64 `egress.write`/`egress.data` until `egress.end`/`egress.close`. The no-NIC rule survives: loopback is not a network device.

**Approval granularity is session-per-destination with remembered approvals only.** The approver caches granted `host:port` in a `WeakMap<Agent, Set>` — the same session's later dials to a cached destination pass without a card, refusals and new destinations always ask, and a dead agent's cache dies with the object. `egress: 'ask' | 'deny'` on the plugin Config (default `'deny'`) is the deployment's one-switch seal; `dsh-base`'s vm row sets `ask`, so a headless composition without a user-questions provider — or one whose ask fails — denies without blocking.

## Alternatives considered

- **Protocol-carried policy / op-level enforcement** — rejected for the same honesty gap as M7's confinement design: the mediation must own the decision, not report it. - **virtio-serial or virtio-net for the proxy channel** — virtio-serial cdev stays ENXIO on this kernel (measured in the seed spike); virtio-net is a NIC and would break the no-network-device posture outright. - **A second world-level approval policy on Config** — a blanket callback cannot route a card to a session; origin registration is the only honest unit because it is the only one carrying attribution. - **Threading an agent/origin field through the `dsh-subprocess` contract** — every caller would pay for a fact ambient context already proves; the packages/AGENTS.md initiator-scope rule names this exact derivation.

## Measured

TCG, one world, local echo server (full tables in `dsh-vm-qemu-local` MEASUREMENTS): small round trip (4 B/9 B) ≈ 21–25 ms; 64 KiB bidirectional ≈ 0.02 MiB/s (double base64 + JSON framing + thread handoffs, ~10× under the raw UART ceiling) — API-call-scale traffic, not bulk. The relay never blocks the guest control loop: inbound bytes queue in per-stream writer threads (a stalled client grows guest memory until its exec budget kills it — recorded as a known limitation).

## Verification

- `subprocess-vm` unit: origin binding/release, unattributed deny, ask-once-cache, cross-initator isolation, no-channel and failing-ask deny (`tests/runtime.spec.ts`). - REAL Loader composition (CI-runnable): the genuine user-questions service with a scripted provider through app-boot — approve+cache, refusal, no-provider default-deny, unattributed deny (`tests/loader.spec.ts`). - QEMU e2e: 3 dials / 2 destinations = exactly 2 cards (cache proven), echoed bytes through the SOCKS path, refused dial fails in-world, unattributed exec denies (`tests/egress.e2e.ts`). - Guest regression: full vm e2e matrix 30/30 after the writer-thread fix.

## Consequences

The egress surface is honest by construction: every reachable dial names a session and asks a card, and every other path denies. The seam grew one method (`registerEgressOrigin`) and one exec option (`origin`) — both purely additive — while the M2-era constructor callback is gone. The guest agent now owns a SOCKS5 surface whose throughput ceiling is the control UART (recorded in MEASUREMENTS); the bridge module carries a documented v8 coverage exemption for the fire-and-forget dispatch blind spot, with its behavior pinned by the dedicated suite, the loader composition, and the QEMU e2e.

## Follow-ups

- Egress bulk-grade channel (M9 long-tail alongside the M5 findings). - Bounded writer inboxes once a stalled-client policy exists. - An `AskUserQuestionIntent` tag for egress cards if UIs want a dedicated rendering (presentation-only, protocol-neutral).
