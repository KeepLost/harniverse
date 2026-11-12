# `@deepseek-ai/dsh-client-ui-settings-shell-backend`

English | [中文](README.zh.md)

The Shell default settings section: the registry-default radio fieldset over the host `shell-registry` settings namespace (`@deepseek-ai/dsh-shell-registry-settings`). Writes go through the bound settings scope as one `default` field; the namespace declares `applies: 'restart'`, so the app boot bridge resolves the stored registry into `$DSH_SHELL_BACKEND` (plus a custom default's executable) and the shell rows re-compose on the next start. The options cover the reserved platform split, the two builtins (`posix`, `pwsh`), and every registered custom entry (labeled with its path); an explicit default is meaningful on every platform.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-shell-backend
  name: '@deepseek-ai/dsh-client-ui-settings-shell-backend'
```

The plugin injects `slots`, `locale`, and `settingsScope`. It contributes one entry to the `settings.section` list slot (id `shell-backend`, order 14 — after Network proxy, before Plugins: the default decides which shell rows the host composes, so it reads with the composition-level settings). The node half is the standard surface no-op; the preference is consumed at boot by `applyShellBackendBootEnv` (`@deepseek-ai/dsh-app-boot`).

## Section behavior

- The form renders once the namespace resolves; a namespace the gateway does not expose shows the unavailable note instead.
- Saving writes the `default` field only when the draft differs from the resolved value, and the settled revision is adopted automatically; an external revision while the draft is clean is adopted the same way.
- The saved notice states the restart effect — nothing switches live.
- A refused write reports the server message; a read-only principal sees every control disabled with the read-only note.

## Model Experience

None, as the section only edits the `shell-registry` settings namespace; the composed shell rows change on the next start, and no model request changes shape.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the section edits the durable preference only; the running process keeps its composed shell family until the next start (the namespace declares `applies: 'restart'`).
- **Entry availability is not probed here** — the form does not verify an executable resolves; a missing installation surfaces through the shell tool on the next start (and the boot probe's warnings), not in this form. Entry CRUD (register/edit/remove custom shells) is deferred: this section edits the default only.
