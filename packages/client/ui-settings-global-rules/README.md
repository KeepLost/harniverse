# `@deepseek-ai/dsh-client-ui-settings-global-rules`

English | [中文](README.zh.md)

The Global rules settings section: a monospace editor over the harness home's `AGENTS.md` (the user-global instruction scope) through the `globalRules` Remote. Saving is version-checked — the section echoes the token from its last read, so an external edit between load and save surfaces as a conflict notice with an explicit reload instead of a silent clobber.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-global-rules
  name: '@deepseek-ai/dsh-client-ui-settings-global-rules'
```

The plugin injects `slots`, `locale`, and `connection`. It contributes one entry to the `settings.section` list slot (id `global-rules`, order 12 — after the model sections, before Plugins: the rules file steers every model turn) and its `settings.nav.icon` glyph (key `global-rules`). The node half is the standard surface no-op; the host-side file service is `@deepseek-ai/dsh-global-rules`.

## Section behavior

- One load on mount shows the content, the symbolic path, and a creation hint when the file is absent; read failures (including deployment without the seam, localized) offer a retry.
- Editing is byte-accounted against the host-reported cap: the counter uses binary units, and an over-cap draft (multibyte-safe) disables saving with an inline alert.
- Saving is enabled only for dirty drafts; a successful save reports the effect semantics — new sessions read the new content on their first step, the current session detects it after its next file operation (the instruction loader's own reconcile).
- A conflict keeps the draft and offers reload (re-reading the file); a refused or failed save reports the server message. "Discard changes" restores the loaded content.

## Model Experience

Indirect and owned elsewhere: the edited file becomes baseline instruction context through `dsh-agent-instructions`. The section itself issues no model request; it only edits the file.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No unsaved-draft persistence** — the draft lives in component state, so leaving the section discards it; a surviving store is deferred until someone actually reports losing a long draft.
- **No diff or Markdown preview** — the editor is plain text over the token-styled monospace face; rendering or comparing against the loaded content is deferred with the draft-persistence decision.
- **Conflict recovery is manual** — the reload path replaces the draft's base with the disk content and drops unsaved edits; a three-way merge is out of scope for a settings panel.
