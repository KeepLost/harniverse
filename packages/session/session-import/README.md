# @deepseek-ai/dsh-session-import

English | [中文](README.zh.md)

The contract for lossy foreign-session import. It classifies a stored header's `version` (`classifyForeignSessionFormatVersion`: this build's own `current`, the official `official-v1`/`official-v2`/`official-v3` generations, or refused `unknown`), defines the archival `import/record` marker event an imported session opens with, validates the default import posture (supervision mode, defaulting to supervised and user-selectable), and owns the exclusion guard `assertNotResumable`.

Imported sessions are settled archival data inside the v0 format: saveable, searchable, and displayable. The marker names the preserved source artifact stored beside the mapped session. Live machinery never picks them up — resume, work-queue admission, approvals, and steering entry points refuse an archival log through the guard. The import never adopts official session vocabulary or builds a migration chain; mapping is one-way and lossy.

This package is contract-only. Reading foreign artifacts, mapping their history into v0 events, and persistence/search integration compose this package in the import runtime.

## Model Experience

### Imported archival sessions

#### What the model sees

Nothing directly: a session opening with `import/record` is never resumed (`assertNotResumable`), so no imported history reaches a model request. If a future product feature quotes imported history into a live prompt, that feature owns the model-visible wording.

#### Token effect

None — the contract contributes no requests.

#### KV Cache effect

None — archival sessions never run.

## Known Limitations and Deferred Work

- Foreign-history mapping (official v1/v2/v3 event vocabulary into v0 display events), source-artifact storage, and search indexing belong to the import runtime; this contract only classifies, marks, validates, and excludes.
- The exclusion guard is a function live entry points must call; wiring it into every queue, approval, and steering caller is runtime integration work.
