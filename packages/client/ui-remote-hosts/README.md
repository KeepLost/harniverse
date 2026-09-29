# `@deepseek-ai/dsh-client-ui-remote-hosts`

English | [中文](README.zh.md)

The Web management surface for SSH-managed remote Harniverse hosts. It adds a sidebar footer entry and a center view beside the existing settings, scheduler, and session-management surfaces. The current local machine remains the workspace context; this view owns host selection and connection operations.

The view uses the generated `remoteHosts` Remote contract. It lists non-secret host records, tests connectivity before saving, saves password or private-key material only through the Host credential provider, connects and disconnects without stopping the remote process, and configures explicit remote-origin to local-destination reverse mappings. Private key values and passphrases are never rendered after submission. A connected row opens a new page scoped by `dshRemoteHost`; the existing local page remains the management authority.

The center view follows the schedules-view skeleton (fixed header with a connected-count summary and actions over a scrolling card list; the add-host editor is a right-hand drawer closed with Escape). Key login defaults to picking the key file, routed by `remoteHosts.keyFilePicker()`: a `native` composition opens the Host's single-file chooser seeded at the operator's `~/.ssh` (`remoteHosts.pickKeyFile()`), while any other (a `browse` or absent picker — the normal case for remote, headless, or SSH-launched Hosts) reads the file through the browser's own file input, with the same 64 KiB bound and the file name labeling the row. One shared password input carries the login password or the key passphrase, whichever the selected method needs. The `paste key text instead` checkbox flips the exclusivity — pasting enabled, file button disabled — and back. Closed `KEY_*` wire codes surface as localized operator copy instead of raw messages.

## Model Experience

None, as this browser-side management surface only exposes authenticated operator actions and registers no model context, tools, events, or request fields.

#### KV Cache effect

No direct effect. The center view does not change model request prefixes.

## Known Limitations and Deferred Work

- The form creates new host records and manages their lifecycle; editing an existing record requires removing and recreating it so a changed fingerprint or credential reference cannot silently alter a connected session.
- Saving requires a successful connectivity test, and any edit to the tested address, port, user, or credential invalidates it, so the form always stores a fingerprint whose login was proven rather than one an operator typed. A later host-key change therefore surfaces as a failed test rather than as silent acceptance.
- Reverse mappings are configured before connection and become active only after the host connection completes; the transport coordinator owns request routing and reconnect state.
- The remote page requires the host to remain connected in the local coordinator; closing the page does not stop the remote process, while disconnecting the coordinator makes the remote page retry until the local host is connected again.
