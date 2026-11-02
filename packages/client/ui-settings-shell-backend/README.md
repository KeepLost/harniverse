# `@deepseek-ai/dsh-client-ui-settings-shell-backend`

English | [中文](README.zh.md)

The Shell backend settings section: the PowerShell / Git Bash radio pair over the host `shell-backend` settings namespace (`@deepseek-ai/dsh-shell-backend-settings`). Writes go through the bound settings scope as one `backend` field; the namespace declares `applies: 'restart'`, so the app boot bridge resolves the stored preference into `$DSH_SHELL_BACKEND` and the shell tool rows re-compose on the next start. The preference is meaningful on Windows only; elsewhere it stays stored but inert.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-shell-backend
  name: '@deepseek-ai/dsh-client-ui-settings-shell-backend'
```

The plugin injects `slots`, `locale`, and `settingsScope`. It contributes one entry to the `settings.section` list slot (id `shell-backend`, order 14 — after Network proxy, before Plugins: the preference decides which shell tool rows the host composes, so it reads with the composition-level settings). The node half is the standard surface no-op; the preference is consumed at boot by `applyShellBackendBootEnv` (`@deepseek-ai/dsh-app-boot`).

## Section behavior

- The form renders once the namespace resolves; a namespace the gateway does not expose shows the unavailable note instead.
- Saving writes the `backend` field only when the draft differs from the resolved preference, and the settled revision is adopted automatically; an external revision while the draft is clean is adopted the same way.
- The saved notice states the restart effect — nothing switches live.
- A refused write reports the server message; a read-only principal sees every control disabled with the read-only note.

## Model Experience

None, as the section only edits the `shell-backend` settings namespace; the composed shell tool rows change on the next start, and no model request changes shape.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the section edits the durable preference only; the running process keeps its composed shell family until the next start (the namespace declares `applies: 'restart'`).
- **Git Bash availability is not probed** — selecting Git Bash does not verify Git for Windows or that `bash` resolves on PATH; a missing installation surfaces through the bash tool on the next start, not in this form.
