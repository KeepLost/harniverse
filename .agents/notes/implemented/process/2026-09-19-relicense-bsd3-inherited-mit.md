# Agent Note: Relicense Harniverse under BSD-3 with an MIT carve-out for inherited DSH code

Status: implemented

English | [中文](2026-09-19-relicense-bsd3-inherited-mit.zh.md)

## Problem

Harniverse has accumulated downstream capabilities, compositions, and documentation that diverge from the official DeepSeek Harness (DSH) development direction, while its top-level LICENSE still pointed at the upstream MIT text. A single MIT file misstates the licensing of downstream-authored work and gives downstream redistributors no distinguishable grant for Harniverse-specific code.

## Decision

The repository license becomes BSD 3-Clause: the root `LICENSE` file now carries the BSD-3 text with the Harniverse copyright line, and the README license section states the split plainly. Harniverse as a whole is distributed under BSD-3, while portions inherited unchanged from official DSH remain under that project's MIT license. The carve-out keeps attribution intact for inherited files without forcing a per-file audit before the first tagged release; the boundary is "inherited unchanged from upstream", which the PLUGINS.md baseline ledger already tracks from a different angle.

## Alternatives considered

- Keeping upstream MIT everywhere: rejected because downstream-authored code would remain indistinguishable from inherited code in licensing terms, and the fork's direction no longer follows upstream.
- A per-file SPDX audit producing a `LICENSE/` directory with separate `LICENSE.BSD-3` and `LICENSE.MIT` file lists: rejected for now as a large mechanical sweep with merge-conflict cost on every future upstream sync; revisit it when cutting the first tagged release if redistribution requires exact file lists.
- Dual-licensing the whole tree under MIT OR BSD-3: rejected because it silently re-grants downstream code under MIT, which contradicts the intent of distinguishing the fork.

## Consequences

Downstream redistributors must carry both the BSD-3 text for Harniverse as a whole and the MIT notice covering inherited DSH portions; the README license section is the authoritative plain-language statement of that split until a per-file audit lands. Future upstream syncs stay mechanically unchanged: inherited files keep MIT, and new downstream work is BSD-3 by default. The first tagged Harniverse release should revisit whether exact file lists are required for compliance tooling.

## Scope

The change covers the root `LICENSE` file, the bilingual README license sections, and this note. No package manifests, THIRD_PARTY_NOTICES.md, or vendored `vendor/` licenses were altered; vendored packages keep their own pinned licenses.
