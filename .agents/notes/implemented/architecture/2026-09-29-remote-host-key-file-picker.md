# Agent Note: Native key-file picking and the redesigned remote-hosts surface

Status: implemented

English | [中文](2026-09-29-remote-host-key-file-picker.zh.md)

## Problem

The add-host form offered exactly one way to supply a private key: paste the PEM text into a textarea. Operators keep keys in files (`~/.ssh/id_ed25519` and company), so every save began with `cat` and a clipboard. The form also used a separate password and passphrase field where one shared secret input would do, and its visual language (sidebar trigger geometry, page skeleton, button and input styling) did not match the sibling center views, which made the whole surface read as bolted on.

Picking a file needs a native OS dialog on the Host's display. The repository already owns that seam for workspace directories — `ctx.directoryPicker` with `native`/`browse` capability arms behind `host.pickDirectory` — but it selects directories only and has no way to seed a start directory.

## Decision

The directory-picker seam gains a single-file interaction instead of a second service. `DirectoryPickerNativeCapability` extends to `pickFile(signal, request?)` with `DirectoryPickerFileRequest { title?, defaultDirectory? }`; the `browse` arm is unchanged, and unknown-kind consumers keep hiding the affordance. The native backend implements it per platform: `choose file default location` through osascript on macOS, `--file-selection --filename=<dir>/` (Zenity) and `--getopenfilename <dir>` (KDialog) on Linux, and the Win32 `IFileOpenDialog` child gains a file mode plus best-effort `SHCreateItemFromParsingName` + `SetDefaultFolder` seeding (an unusable seed degrades to the dialog's own start location instead of failing the pick). A start directory the host cannot see is dropped at the adapter boundary — osascript would otherwise hard-fail the whole chooser. The Electron owned-Host path threads `pickFile` through the same parent-callback IPC as `pickDirectory` (`file-pick`/`file-result`/`file-cancel` messages with the same single-flight and abort rules).

`RemoteHostsProvider.pickKeyFile()` is the Consumer face: a `remoteHosts` Remote method under `harniverse.administer` that resolves the picker through `ctx.get('directoryPicker')` (optional service — a composition without the `native` capability fails fast with `KEY_PICKER_UNAVAILABLE`), seeds the chooser at `join(homedir(), '.ssh')`, and returns `{ path, content }` for display and one-shot use. Content is capped at 64 KiB (`KEY_FILE_TOO_LARGE`); vanished or unreadable picks report `KEY_FILE_READ_FAILED`; foreign chooser failures are contained as `KEY_PICKER_FAILED`. The path is never persisted — host configuration keeps holding references only.

The browser surface is rebuilt to the schedules-view skeleton: fixed header with a connected-count summary and action row over a scrolling card list; the editor is a right-hand drawer (`role="dialog"`, Escape closes); tokens replace the ad-hoc palette; the phone form follows the frame's `data-viewport='phone'` convention instead of a media query. Key login defaults to file picking: the drawer shows the path the Host picked and a `paste key text instead` checkbox whose two states are mutually exclusive — pasting enabled disables the file button, unchecking re-enables the button and disables the textarea. One shared password input carries the login password or the key passphrase for the selected method; picking loads file content as the tested secret, and both sources invalidate a completed connectivity test through the existing `testedFields` rule.

## Alternatives considered

- A browser `<input type="file">` like the attachment flow: rejected because it reads the browser's machine, displays no host path, cannot seed `~/.ssh`, and leaves the desktop (Electron) case reading the wrong process's filesystem.
- A generic `host.pickFile` RPC returning arbitrary host file content: rejected as a wider security surface than the feature needs; the typert Remote keeps the operation named, capability-gated, and inside the remote-hosts namespace that never proxies to a connected remote host.
- Extending `pickDirectory` with a mode flag: rejected because directory and file selection are different interactions of the same backend, which is exactly what the seam's discriminated capability union models; a boolean flag would make every caller branch.
- Reading the key file by path at connect time (persisting the path): rejected because persisted host configuration holds credential references only, and a path would silently break when the file moves; the picked content flows through the existing one-shot `AuthSecrets` and credential-storage rules instead.
- Seeding the dialog from the client (passing `~/.ssh` from the browser): rejected because the Host owns the dialog and the home directory that matters is the Host account's; the seed is computed host-side.

## Consequences

Key-file picking works where the operator sits at the Host's display — the same accepted limitation as the workspace picker. Remote/browse compositions surface `KEY_PICKER_UNAVAILABLE` in the form and fall back to pasted key text; the limitation is documented in the ui-remote-hosts README. The win32 COM additions (slot-11 `SetDefaultFolder`, shell32 parsing) are fake-tested through the existing bindings/worker harness; the real-COM path is exercised only on actual Windows hosts, matching the pre-existing picker's test posture.

The typed-key flow is unchanged apart from ergonomics: pasted or picked material is a one-shot secret, saved only through the credential provider under `storeCredentials`, and never rendered after submission. The IPC protocol between the Electron shell and the owned Host child grows `file-pick`/`file-result`/`file-cancel` with exact-key validation mirroring the directory messages.

Verification lives in the native-picker suite (per-platform file adapters, seeded and dropped start directories, AppleScript escaping, cancellation), the win32-dialog logic/bindings suites (file-mode options, `SetDefaultFolder` success/failure/degradation, worker mode and seeding), the desktop-host composition and lifecycle suites (callback threading, correlated `file-result`, abort), the remote-hosts coordinator suite (happy pick, cancel, vanished/oversized/unavailable picker, contained failures), the typert roster, and the browser view suite (file pick loads and invalidates, cancel and failure paths, manual-paste exclusivity, shared credential field mapping, Escape drawer).
