# `@deepseek-ai/dsh-client-ui-settings-network-proxy`

English | [中文](README.zh.md)

The Network proxy settings section: the off / system / manual radio fieldset over the host `network-proxy` settings namespace (`@deepseek-ai/dsh-network-proxy`). Writes go through the bound settings scope field-by-field — mode, `url`, `noProxy` (an emptied optional clears its override) — and the host plugin resolves each committed change into a live route through `setProxyOverride`; saving never restarts anything.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-network-proxy
  name: '@deepseek-ai/dsh-client-ui-settings-network-proxy'
```

The plugin injects `slots`, `locale`, and `settingsScope`. It contributes one entry to the `settings.section` list slot (id `network-proxy`, order 13 — after Global rules, before Plugins: the route steers every outbound connection, so it reads with the connection-level settings). The node half is the standard surface no-op; the setting itself is applied live by the `@deepseek-ai/dsh-network-proxy` host plugin.

## Section behavior

- The form renders once the namespace resolves; a namespace the gateway does not expose shows the unavailable note instead.
- `manual` reveals the address pair; an emptied `noProxy` list clears the override, and a `url` that is not a parseable http(s) URL keeps saving disabled with an inline alert (the host would warn and keep the launch route anyway).
- Saving writes only the changed fields, in order (mode, url, noProxy), and the settled revision is adopted automatically; an external revision while the draft is clean is adopted the same way.
- A refused write reports the server message; a read-only principal sees every control disabled with the read-only note.

## Model Experience

None, as the section only edits the `network-proxy` settings namespace; prompts, tools, and schemas are untouched.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **No live detection verdict** — the section edits the durable fields only; the effective route (including a warned fallback) stays in host logs until a settings view can carry read-only diagnostics.
- **Client-side URL gate duplicates the host's** — the form rejects non-http(s) URLs before the wire; the host remains the enforcer (it warns and keeps the launch route), so the two gates can drift cosmetically but never behaviorally.
