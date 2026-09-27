# dsh-credentials-encrypted

English | [中文](README.zh.md)

Encrypted [CredentialProvider](../credentials/README.md) for a remote runtime whose model and search credentials remain authoritative on the local client. The default export is `EncryptedCredentialProvider`, registered once as `ctx.credentials`. The package also exports the class and the `EncryptedCredentialControl` interface; there is no second service instance or context key.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.credentials.encrypted.json` | Encrypted snapshot location. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted. |

Configuration contains file locations only. The coordinator supplies the encryption key at runtime over its authenticated, authorized channel. Keys and credential values are never loaded from the remote environment or plugin configuration.

## Runtime control

The coordinator declares an injection on `credentials` and narrows `ctx.credentials` with `instanceof EncryptedCredentialProvider`. That object implements both the credential service and its controls:

| Method | Contract |
|---|---|
| `unlock(key: string): Promise<void>` | Accept 32 cryptographically random bytes encoded as canonical unpadded base64url (43 characters). Authenticate and load the existing document, or start an empty session if the file is absent. |
| `replace(values: Record<string, string>): Promise<void>` | Durably replace the entire snapshot. Omitted references are deleted; `{}` removes all credentials. Requires an unlocked provider. |
| `status(): { locked: boolean }` | Return availability immediately without exposing key material or credential metadata. |
| `lock(): Promise<void>` | Immediately overwrite owned key buffers with zeros, clear values, cancel queued operations, and await outstanding file I/O. Safe to repeat, including after disposal. |

These are trusted in-process control methods, not authentication endpoints. The coordinator must authenticate and authorize remote requests before calling them and must protect their request bodies from logging. `set` and `unset` always reject remote edits with a local-authority error. `describe` always reports `writable: false`; while locked or disposed it reports `configured: false`. Unlocked resolution returns source `encrypted` and ignores ambient credentials.

Startup registers a locked service without opening the document or waiting for a key, allowing authentication/bootstrap services to become ready. `resolve` rejects immediately while locked; it never waits for a reconnect. After a process restart, the coordinator must reconnect and unlock before model/search operations can resolve credentials. Disposal locks permanently and rejects further unlock, replacement, resolution, and writes.

An unlock with the current key is idempotent. An unlock with a different key rejects and preserves the active session. After locking, an incorrect key, unreadable document, corrupt payload, or unsupported version rejects with the same sanitized `credentials-encrypted: unlock failed` error and leaves the provider locked. An absent file acquires its durable key association on the first successful replacement.

## Persistence and notifications

The version-1 JSON envelope contains only `version`, `iv`, `tag`, and `ciphertext`. AES-256-GCM uses a fresh random 12-byte IV on every replacement, a 16-byte authentication tag, and package/version-specific authenticated data. Credential values and reference names are inside the ciphertext. Decryption authenticates before parsing values; malformed envelopes and invalid snapshots fail closed.

Each commit writes a randomly named, exclusively created `0600` sibling, syncs the file, closes it, atomically renames it, and syncs the containing directory on POSIX. The immediate parent is created `0700`; an existing parent with group/other permissions is rejected. Newly created directory entries are synced through their existing ancestor before committing. Reads reject non-regular files, final-component symlinks, and broadly accessible POSIX files. Windows does not provide the POSIX permission checks or directory-sync guarantee.

Before rename, a failed write preserves the last committed file and in-memory values and emits no event. If rename succeeds but directory sync or close fails, durability is uncertain: replacement rejects, locks the provider, and emits no event. Reconnect/unlock reads the actual file before a retry.

Successful replacement publishes the whole snapshot before emitting `credentials/updated` once per added, changed, or deleted reference. Unchanged values emit no event, even though replacement produces fresh ciphertext. Unlock and lock do not emit durable-update events. Listener failures follow the [credential service contract](../credentials/README.md); invariant failures propagate after changed-reference fan-out.

Unlock and replacement serialize in admission order, with at most 16 outstanding operations; additional calls reject as busy. Lock invalidates queued work immediately. An already-started encrypted rename can finish while locking or disposing; its replacement promise can succeed, but it cannot republish values or events. `lock` and disposal complete only after that I/O settles.

## Bounds

Snapshots allow at most 1,024 entries, POSIX-style references up to 128 ASCII characters, and non-empty string values up to 65,536 UTF-8 bytes each. The complete serialized plaintext, including JSON escaping and metadata, is bounded to 1,048,576 bytes. Encrypted files are bounded to 1,500,000 bytes, including their envelope; reads allocate and consume at most that bound plus one byte. Input records are copied and validated at admission so later caller mutation cannot change queued commits.

## Model Experience

None, as credential encryption and resolution authorize consuming providers without registering prompt text, tool schemas, model-visible output, or request fields.

#### KV Cache effect

No direct invalidation; credential material never enters request prefixes.

## Known Limitations and Deferred Work

- One provider process owns each document. There is no cross-process writer coordination or file watcher; external changes require lock/unlock to reload.
- This protects persisted credentials at rest. An authorized plugin or a process able to inspect the unlocked runtime can still obtain secrets. Callers own any copies returned by `resolve`.
- JavaScript strings, caller-owned base64url keys, and native cryptographic copies cannot be reliably overwritten. Lock/disposal explicitly zero provider-owned key buffers and release value references; they cannot revoke previously returned values.
- There is no automatic key recovery, rotation, or authenticated revision history. Losing the local key makes an existing file unreadable; valid older ciphertext can be replayed until the local authority replaces it.
- Storage calls follow operating-system I/O completion. Queue size and document sizes are bounded, but a stalled filesystem can delay lock/disposal completion.
