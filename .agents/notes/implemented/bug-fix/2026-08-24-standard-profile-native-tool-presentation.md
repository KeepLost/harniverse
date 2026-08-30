# Agent Note: Keep Code Mode opt-in and expose run_code as a capability member

Status: implemented

English | [中文](2026-08-24-standard-profile-native-tool-presentation.zh.md)

## Problem

The Web UI showed a Standard Profile whose tools were all wrapped in `run_code`, although the shipped Standard composition is native. The composition catalog was building one recipe universe from all Profiles and, for the global target, marked a capability loaded when any Profile loaded its row. Because only the Code Profile contains `tool-presentation`, the global catalog treated Code Mode as a default capability. That made a Profile-local presentation choice easy to inherit accidentally and made the UI state misleading.

The capability adapter also did not describe `run_code` as a member of the presentation capability. The row could be toggled, but the actual model-facing transport was not visible as an independently selectable member, and custom member selection could not disable an inserted top-level recipe.

## Decision

Global catalogs now treat every capability as unloaded by native default. A global target supplies explicit inherited overrides; it is not the union of native defaults from unrelated Profile recipes. Profile-targeted catalogs still read `defaultLoaded` from that Profile's source row, so Standard remains native and Code remains Code Mode by default.

`@deepseek-ai/dsh-agent-tool-presentation` contributes a visible `run_code` member. Member selection is compiled for inserted and source rows alike. A selected `run_code` member inserts an enabled presentation row; a custom selection that hides it inserts the row disabled, so the effective generation cannot silently activate Code Mode without that member.

## Testing

The composition unit suite now proves that the global catalog keeps the Code-only presentation opt-in, exposes `run_code`, does not insert Code Mode into Standard native defaults, and compiles enabled and disabled `run_code` member selections.

The real Web composition suite mounts both shipped Profiles and assembles their system prompts: Standard contains native `read` and no `run_code`, while Code's wire tool set is exactly `[run_code]`. This test uses the real Profile recipe files and Loader path rather than a hand-built service fixture.

The HTTP/RPC carrier and session gateway suites pass as well, covering the session list/status/create/history path used to inspect this behavior without a browser.

## Alternatives considered

**Keep the global union default and special-case Code Mode.** Rejected because any future Profile-local capability would leak the same way. The global target has different semantics and must not infer a deployment default from one Profile's source row.

**Treat `run_code` as only a presentation detail.** Rejected because it is the actual model-facing transport and operators need to see and control it when composing a Profile.

**Disable only the presentation row when its member is hidden.** Rejected for inserted recipes because the old compiler forcibly reset `disabled` to false after member selection. The compiler now preserves the selected member result for both inserted and source rows.

## Consequences

Standard and other native Profiles no longer inherit Code Mode merely because the Code Profile exists in the same recipe universe. Code Mode remains fully available through the Code Profile and can be explicitly selected as a global or Profile capability through `run_code`.

The global composition page now represents explicit global overrides rather than a union of Profile-native defaults. Profile pages remain the authoritative view of each shipped Profile's native composition.
