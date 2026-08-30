# Agent Note: Unified Dynamic Prompt Context and Built-in Runtime Defaults

Status: implemented

English | [中文](2026-08-30-unified-dynamic-prompt-and-runtime-defaults.zh.md)

## Problem

The built-in Agent Profiles describe different capabilities, but their persona and runtime prompt behavior must not diverge merely because one Profile has a smaller roster. Static system sections mixed stable identity with session-specific checkout, Web surface, and persona facts. The user Hook bridges also loaded by default, workspace instruction discovery accepted Claude Code file names, and automatic TODO continuation was recorded as an undifferentiated plugin user message.

## Decision

All built-in Profiles use the same `dsh-system-prompt` assembly path. The stable identity is the static system section `You are an AI agent powered by Harniverse.`. The deployment persona, scoped `dsh-persona` persona, harness checkout context, and Web surface context are dynamic contexts rendered into the durable runtime-context snapshot. Minimal differs only through the capabilities it mounts; it does not use a separate static persona, complete-prompt path, or runtime-context suppressor.

The deployment persona and scoped Profile persona use one named dynamic context slot, `deployment:persona`. A scoped persona replaces the deployment value through normal scope precedence, and `{{model}}` and `{{cwd}}` are interpolated during assembly. Shipped Profile rows do not set `complete` or `includeRuntimeContext` to implement their capability differences.

The checkout and Web surface texts keep their established wording and ordering, but are registered through `systemPrompt.context()` rather than `systemPrompt.section()`. The Web and checkout contexts remain gated by the existing Web surface configuration. Child-agent persona overrides use the same dynamic context registration and scope shadowing.

The Claude Code and Codex compatibility bridge rows remain available for explicit opt-in but are disabled in every checked-in shipped composition, including the ACP example composition. Native Cordis Hook extension points remain independent of those bridges.

The workspace instruction loader recognizes `AGENTS.md` and `AGENTS.local.md` as its built-in project names. `CLAUDE.md` and `CLAUDE.local.md` are rejected even when listed explicitly; unrelated same-directory custom candidate names remain configurable. The fixed user-global file remains `$DSH_HOME/AGENTS.md`, and repository `CLAUDE.md` symlinks are not changed.

Automatic TODO continuation remains a user-role message on the current Session surface for protocol compatibility, but its plugin source carries `form: 'system-injection'`. The default continuation identifies itself as an automatic system injection rather than a user request and instructs the model to mark every TODO `completed` before stopping once all work is done. An explicit `autoContinueMessage` remains caller-owned text. The UI and trajectory source presentation expose the dedicated form while unknown forms continue to degrade to opaque content.

## Verification

System-prompt, persona, agent-loop, app-boot, Web-app, subagent, and shipped-composition tests pin the static identity, dynamic context ordering, scope shadowing, first-request assembly, and Minimal's shared loading path. Hook, agent-instructions, TODO, runtime provenance, conversation, and trajectory tests pin the disabled defaults, rejected Claude Code candidates, system-injection source form, completion guidance, and user-visible marker. Generated catalogs and graph documents are refreshed and freshness-gated from the current source.

## Alternatives considered

**Keep Minimal on a static complete persona.** Rejected because a smaller capability roster does not justify a second prompt assembly mechanism. It would make Prompt behavior depend on Profile implementation rather than on mounted capabilities.

**Add an opt-in `dynamicContext` flag to `dsh-persona`.** Rejected because every shipped persona needs the same behavior; a flag would preserve the unnecessary dual path and invite future Profile drift.

**Introduce a new Session system-message event for TODO continuation.** Rejected for this change because the Session surface, delivery, and wire path already represent injected context as user-role messages. Source metadata communicates producer and presentation semantics without changing the durable protocol.

**Remove the Hook bridge packages instead of disabling their rows.** Rejected because explicit compatibility use remains supported and the bridge implementation is independent of the shipped default.

**Remove only CLAUDE defaults but allow explicit CLAUDE candidates.** Rejected because that would retain the support the decision removes and make the effective contract depend on hidden configuration.

## Consequences

The first request keeps the Harniverse identity and other static tool guidance in `request.system`; checkout, Web orientation, and Profile persona arrive in the logged dynamic runtime-context message. Moving persona into dynamic context makes it subject to the existing snapshot lifecycle, so a deployment that explicitly suppresses all runtime contexts must not use that setting as a built-in Profile implementation. Existing raw Session logs retain historical CLAUDE content; the loader does not delete history, but current discovery and resume reconciliation no longer load those names.

Hook compatibility remains opt-in in shipped defaults, while native Cordis hooks continue to operate independently. TODO continuation is visibly and durably distinguishable from a human user message without introducing a new Session role or event. The UI treats the new form as a dedicated marker and keeps the opaque fallback for future forms.
