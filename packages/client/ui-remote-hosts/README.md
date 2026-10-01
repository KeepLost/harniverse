# `@deepseek-ai/dsh-client-ui-remote-hosts`

English | [中文](README.zh.md)

The Web management surface for SSH-managed remote Harniverse hosts. It adds a sidebar footer entry, a center view beside the existing settings, scheduler, and session-management surfaces, and the sidebar machine indicator in the `sidebar.workspaces.machine` slot. This view owns host selection and connection operations; the active workspace machine stays the page's connection target until a row or the indicator switches it.

The view uses the generated `remoteHosts` Remote contract. It lists non-secret host records, tests connectivity before saving, saves password or private-key material only through the Host credential provider, connects and disconnects without stopping the remote process, and configures explicit remote-origin to local-destination reverse mappings. Private key values and passphrases are never rendered after submission. A connected row switches the whole page to that machine in the same document through the connection target seam, and the view closes itself; the sidebar machine indicator then names the active machine (resolving its configured display name) and offers an unconditional return-to-host action, while host management keeps the original page authority.

The center view follows the schedules-view skeleton (fixed header with a connected-count summary and actions over a scrolling card list; the add-host editor is a right-hand drawer closed with Escape). Key login defaults to a host-local path, routed by `remoteHosts.keyFilePicker()`: a `native` composition opens the Host's single-file chooser seeded at the operator's `~/.ssh` (`remoteHosts.pickKeyFile()`); a `browse` composition opens the in-app key-file browser (`remoteHosts.listKeyFiles()`), which lists one directory level of the machine the Host runs on — never the browser's — where directories enter the next level and files pick directly, so the chosen credential is always a concrete file; a probe failure leaves manual path typing. The stored credential is the path itself; the Host reads the file at use time under the same 64 KiB bound. One shared password input carries the login password or the key passphrase, whichever the selected method needs. The `paste key text instead` checkbox flips the exclusivity — pasting enabled, path input and pick button disabled — and back. Platform and architecture default to `decide at connect`: the editor keeps them behind a collapsed optional section, and saving resolves them from the values the connectivity test detected unless the operator pinned explicit ones. Closed `KEY_*` wire codes — and the connect-time `ARTIFACT_NOT_FOUND` / `INVALID_ARTIFACT` / `CREDENTIAL_REQUIRED` reasons — surface as localized operator copy instead of raw messages.

Connect feedback is immediate: the clicked row shows the connecting state from the first click, before any coordinator state arrives, and the list polls while a connect is pending or any host is connecting or deploying. A deploying row reports the coordinator's bounded `progress` field: the current phase — checking the remote-server artifact, uploading it (with per-file counts on the only phase that has them), verifying, preparing remote authorization, starting the remote server, opening the SSH tunnel, synchronizing settings and credentials — rendered with an accessible label. A failed or rejected switch surfaces its error inside this view; switching machines never navigates away.

## Model Experience

None, as this browser-side management surface only exposes authenticated operator actions and registers no model context, tools, events, or request fields.

#### KV Cache effect

No direct effect. The center view does not change model request prefixes.

## Known Limitations and Deferred Work

- The form creates new host records and manages their lifecycle; editing an existing record requires removing and recreating it so a changed fingerprint or credential reference cannot silently alter a connected session.
- Saving requires a successful connectivity test, and any edit to the tested address, port, user, or credential invalidates it, so the form always stores a fingerprint whose login was proven rather than one an operator typed. A later host-key change therefore surfaces as a failed test rather than as silent acceptance.
- Reverse mappings are configured before connection and become active only after the host connection completes; the transport coordinator owns request routing and reconnect state.
- The remote machine target requires the host to remain connected in the local coordinator; leaving the page does not stop the remote process, while disconnecting the coordinator makes the remote target retry until the local host is connected again.
