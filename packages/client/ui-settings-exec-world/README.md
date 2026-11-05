# `@deepseek-ai/dsh-client-ui-settings-exec-world`

English | [中文](README.zh.md)

The execution world settings section: the host-local / VM world radio pair over the host `exec-world` settings namespace (`@deepseek-ai/dsh-exec-world-settings`). Writes go through the bound settings scope as one `world` field; the namespace declares `applies: 'restart'`, so the app boot bridge resolves the stored preference (plus the VM provider probe) into `$DSH_EXEC_WORLD` and the capability-family rows re-compose on the next start; an unhealthy probe degrades back to the local family.

## Composition

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-exec-world
  name: '@deepseek-ai/dsh-client-ui-settings-exec-world'
```

The plugin injects `slots`, `locale`, and `settingsScope`. It contributes one entry to the `settings.section` list slot (id `exec-world`, order 17 — the composition-level group is full at 13–16, so the world picker takes the next slot ahead of the per-agent sections: it swaps capability families exactly like its neighbors swap the shell stack). The node half is the standard surface no-op; the preference is consumed at boot by `applyExecWorldBootEnv` (`@deepseek-ai/dsh-app-boot`).

## Section behavior

- The form renders once the namespace resolves; a namespace the gateway does not expose shows the unavailable note instead.
- Saving writes the `world` field only when the draft differs from the resolved preference, and the settled revision is adopted automatically; an external revision while the draft is clean is adopted the same way.
- The saved notice states the restart effect — nothing switches live.
- A refused write reports the server message; a read-only principal sees every control disabled with the read-only note.

## Model Experience

None, as the section only edits the `exec-world` settings namespace; the composed capability families change on the next start, and no model request changes shape.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the section edits the durable preference only; the running process keeps its composed capability family until the next start (the namespace declares `applies: 'restart'`).
- **VM availability is not probed in the form** — selecting the VM world does not verify QEMU or staged assets here; an unhealthy provider degrades at the next start with one boot notice from the boot bridge.
