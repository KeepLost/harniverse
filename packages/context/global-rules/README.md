# `@deepseek-ai/dsh-global-rules`

English | [中文](README.zh.md)

The user-global rules editor Service Definition (`ctx.globalRules`): reads and writes the harness home's `AGENTS.md` — the file the `dsh-agent-instructions` loader treats as the `user-global` scope — with a content-derived freshness token for optimistic conflict detection. Loaded as a plugin it registers as `ctx.globalRules`; the settings-panel wire (`globalRules.read` / `globalRules.write` on the API proxy) is the primary Consumer.

## Resolution and limits

Home resolution mirrors the loader exactly: an explicit `dshHome` config wins, then a non-blank `$DSH_HOME`, then `~/.dsh` (`resolveDshHome`). The write cap defaults to the loader's per-file source cap (1 MiB) so anything the editor accepts is loadable by the loader's default; a composition overriding either should set both to match. `maxSourceBytes` config overrides the cap.

The display path is always symbolic (`~/.dsh/AGENTS.md` or `$DSH_HOME/AGENTS.md`); absolute machine paths never leave the host.

## Contract

- `read()` answers `{ exists, content, version, displayPath, maxBytes }`; a missing file is `exists: false` with empty content and no token, and anything other than absence throws to the caller.
- `write(content, expectedVersion?)` enforces the cap first (UTF-8 bytes, multibyte-safe), then compares the on-disk content's token against `expectedVersion` when one is given — a mismatch refuses the write as `conflict` with the current token so a concurrent external edit is never silently clobbered. Omitting the token writes unconditionally. A successful write creates the harness home when absent and answers the new token.
- Tokens are sha256 prefixes of the content itself: rewriting identical content keeps the token stable, so the conflict check is about content identity rather than write history. The compare-then-write pair is best-effort optimistic locking, not a transaction.

Every session picks an edit up through the loader's own reconcile — new sessions on their first step, live sessions after their next file operation; this service adds no propagation of its own.

## Model Experience

Indirect and owned elsewhere: the file this service edits becomes baseline instruction context through `dsh-agent-instructions`, whose README owns the model-visible effects. Editing or saving rules issues no model request from this package.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Optimistic locking is not a transaction** — the version compare and the write are two filesystem steps, so two racing writers can both pass the check; the last write wins. A lock file or rename-based swap is deferred until a real collision report exists.
- **An absent file has no token** — a client that loaded `exists: false` cannot express "still absent" on save, so its unconditional write may clobber a file created meanwhile; the conflict notice appears only for clients that loaded content.
- **One file, one scope** — only the user-global `AGENTS.md` is served; project-scope files and `AGENTS.local.md` overlays stay with the loader (and the workspace editor) and are out of scope here.
