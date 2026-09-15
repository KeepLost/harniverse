# Agent Note: Declaring custom-model capabilities — image input, thinking levels, and their dispatch

Status: implemented

English | [中文](2026-09-14-custom-model-capability-declaration.zh.md)

## Problem

A custom (hand-declared) model connected through the Models settings page could declare nothing about itself except an id, a display name, and two capacities. Every capability field the adapter's schema already owned — `input` modalities, `reasoningEfforts`, the dispatch dialect — was YAML-only, so the page's own summary was true: everything else lived in `settings.yaml`. The consequences compounded downstream:

- An image-capable local model was permanently text-only: `read_image` refused it, and the image-bearing-message preflight rejected model switches, both correctly following a declaration no surface let the operator make.
- A reasoning model exposed no effort control at all (the deliberate no-fake-`off` posture), and the per-model default effort that would make switching models land on the right level did not exist even in YAML.
- A local endpoint whose thinking switch travels in a field no named dispatch format spells had no escape: `chat-template` was withheld from the configuration surface precisely because its `chatTemplateKwargs` were not exposed.

## Decision

**Declaration surface (this change).** The per-model disclosure in the Models settings page now carries a capability section, writing only fields the `llm-pi-ai` schema already validated:

- **Image input** — a checkbox writing `input: [text, image]`; unchecked leaves the field to the installed entry and the route default. The DeepSeek catalog editor gains the same checkbox for `inputModalities`.
- **Reasoning** — checking it declares the offered levels (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, at least one besides `off`), each optionally carrying its wire spelling (empty = canonical; `off` empty = send nothing), plus `defaultReasoningEffort`: a declared level, `off`, or `default` — the model's explicit "send no effort", which stops the route-level `reasoning` default. Unchecking removes the declaration rather than storing `false`; stripping a catalog model's reasoning stays a YAML edit.
- **Dispatch (openai-completions routes only)** — the `thinkingFormat` select, and under `chat-template` a `chatTemplateKwargs` editor (field name → literal / `thinking.enabled` / `thinking.effort`, each optionally `omitWhenOff`). Leaving the format drops the kwargs with it.

**Schema side.** `PiAiModelProfile.defaultReasoningEffort` joins the schema; `chat-template` is un-withheld and `chatTemplateKwargs` joins `PiAiCompatProfile`, resolving model → route and refused when the resolved format is not `chat-template` (dead configuration is a typo someone would hunt in the request body). Resolution carries `configuredDefaultEffort` per model, and `resolveModel` prefers it over the route default — `describableReasoningLevel` semantics unchanged.

**Consumer side stays untouched by design.** `reasoningInfo`, the effort picker, `read_image`'s route gate, and the apiproxy preflights all read the resolved metadata, so a saved declaration takes effect without any consumer change. The in-session effort button beside the model selector is deliberately deferred to a follow-up PR.

## Evidence

- `llm-pi-ai` suites (242 tests): per-model default precedence (pinned / `default`-suppressed / inherited), rejection of a default outside the declared set or beside no declaration, `chat-template` materialization with kwargs, kwargs-under-other-format refusal, and the pre-existing compat-switch matrix.
- `ui-settings-models` suites (252 tests): form round-trips — image + narrowed effort set + wire spelling + default; the empty-set refusal blocking Apply; chat-template kwargs landing as `{$var}` objects; the DeepSeek `inputModalities` checkbox replacing one row of the catalog array.
- `pnpm run test:gui` 330 files / 4938 passed; `typecheck`, `lint:contracts-ready`, `doc-sync` 29/29; `docs/config-catalog.md` regenerated and both README pairs brought along.

## Alternatives considered

**Default-expose capabilities from listing endpoints.** No listing endpoint reports modalities or a reasoning protocol (the adapter's own discovery reads ids and capacities only); a guess that over-claims admits images the provider rejects mid-turn, after the message is durable. The declaration stays the operator's claim, and the page says so.

**A `false` spelling in the form.** Unchecking reasoning removing the field keeps "inherit the installed entry" expressible; a three-state control for the rare strip-a-catalog-model case would spend form complexity where YAML already answers.

**Per-level wire inputs everywhere, including `off`.** Kept — `off`'s empty value already means "send nothing" and its filled value names what a dialect like openrouter's `none` sends, so the same input serves both.

## Consequences

The capability gap for custom models closes at its root: one declaration surface, schema-validated, with every downstream gate reading it unchanged. The known ceiling moves to the one place left: a thinking switch in an arbitrary *top-level* field still has no named format (chat-template nests under `chat_template_kwargs` only); the closure path is a custom stream wrapper and is recorded as deferred until a real server needs it.
