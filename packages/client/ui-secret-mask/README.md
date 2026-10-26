# @deepseek-ai/dsh-client-ui-secret-mask

English | [中文](README.zh.md)

Credential display masking for sent Web user text. A user message that pastes a recognized credential — a provider API key, a code-hosting or package-registry token, a cloud access key ID, a JSON Web Token, a private key block, or the password of an address that carries credentials — draws that value masked: a prefixed key keeps its first eight characters and each remaining character draws as a mask mark. Masking changes only what is drawn; the message text, the copy action, and the model input keep the original characters.

This is a pure client plugin: it registers one rule into the conversation service's sent-user-text face (`ctx.conversation.sentUserText`), plus its locale dictionaries. The shipped Web composition mounts it; removing its row draws credentials as written.

## Use this package

Mount the plugin beside `dsh-client-ui-conversation`. Every user bubble drawn by the conversation chat view consults the seam: plain segments keep the existing reference-chip decoration, matched ranges render through the rule's `SecretText` component. A sent or admitted steering message is interactive: an eye control at the end of each masked value reveals or hides that one value, and every mount starts masked. Pending pre-admission echoes draw the masked value with no control.

## What is masked

| Value | Examples | Display |
| --- | --- | --- |
| Model-service and Google API keys | `sk-…` with a digit among the first 256 characters, `AIza…` | First eight characters kept |
| Code-hosting and package-registry tokens | `ghp_…`, `github_pat_…`, `glpat-…`, `npm_…`, `hf_…` | First eight characters kept |
| Cloud access key IDs | `AKIA…`, `ASIA…`, `LTAI…`, `AKID…` | First eight characters kept |
| Collaboration and payment tokens | `xox[a/b/p/r/s]-…`, `sk_live_…`, `rk_test_…`, `whsec_…` | First eight characters kept |
| JSON Web Tokens | `eyJ…` three dot-joined runs | First eight characters kept |
| Private key blocks | `-----BEGIN … PRIVATE KEY-----` | `BEGIN`/`END` lines kept, body masked |
| Address passwords | `scheme://user:password@…` | Password masked; user, host, and path stay readable |

A value is recognized by its published format alone. Free-form passwords, `name=value` assignments, and ordinary words never match, and the recognizer never reads configuration or stored credentials — it cannot know which secrets are real, so it draws by shape.

## Implementation

The matcher is a prefix-pruned linear scanner (`CredentialScanner`): a literal-only alternation finds each place a format can begin, format checks are bounded character-class runs that cannot backtrack, and run ends plus key-block ends are memoized per text across queries. Recognition never allocates before it returns a range. The `benchmarks/user-text.bench.ts` gate holds the per-document cost budget so a backtracking regression cannot land silently.

## Model Experience

None, as masking is display-only in the Web client: no durable event, tool schema, or model request changes.

#### KV Cache effect

Masking never leaves the browser; no request prefix exists to invalidate.

## Known Limitations and Deferred Work

- **Only sent user text is masked** — assistant output, tool results, and the composer draft render as written. The composer preview is the natural follow-on surface.
- **Recognition is format-only** — an unpublished or custom format stays plain; there is no configured-secret list to match against.
- **Reveal state is per mount** — navigating away and back re-masks; the state is deliberately not persisted.
