# Desktop-owned Host

English | [中文](README.zh.md)

This private process composes the downstream `web` profile with app-local Providers for HTTP admission and native directory picking, plus a Consumer of authentication, session status, terminal listing, and scheduler listing. The profile binds the stable loopback origin `127.0.0.1:19387` in authenticated mode so the browser device key survives a desktop restart. The existing Loader, agents, scheduler, terminals, browser authentication, and API gateway retain their normal ownership.

The shell forks `lib/index.js` with `--expose-internals` and two absolute application arguments: its dedicated Host home and the installed `@deepseek-ai/dsh/package.json` path. A private `--port <number>` override permits isolated tests; zero requests a free port. Production uses port 19387 and fails clearly on a conflict instead of changing the browser origin. The shell passes inherited Node IPC and only allowed OS environment variables; Electron Node mode is selected explicitly. The child also scrubs credential names and Node/Electron/DSH execution overrides before profile activation, and publishes that sanitized launch snapshot for subprocess Providers. PTC's Electron executable adaptation belongs to the W09 Provider.

The home must be empty or carry the `.desktop-owned` marker, be a real directory, and have owner-only permissions on Unix. Default user homes are refused. The normal authentication Provider owns the exclusive, crash-recoverable network-process lease. Each attempt gets a separate private Loader root and dependency links, removed after disposal; existing profile config and user patches are never truncated. The executable Profile accepts only the distribution's Web bundle tuple, without user patch layers or runtime package installation. Shutdown retains durable data.

## Private IPC

Only the inherited parent channel accepts controls. Commands reject unknown fields. Request ids are nonnegative safe integers and must increase across shell requests; picker responses use their separate child-issued ids.

| Parent command | Child response |
| --- | --- |
| Startup | `{ type: 'ready', url, authentication: 'authenticated' }` |
| `{ type: 'enroll', requestId, publicKey }` | `{ type: 'enrolled', requestId, enrollment: { enrollmentId, grant } }` |
| `{ type: 'activity', requestId }` | `{ type: 'activity', requestId, activity }` |
| `{ type: 'update-tasks', requestId, action: 'inspect' \| 'lock' \| 'unlock' }` | `{ type: 'update-tasks', requestId, active, activity }` |
| `{ type: 'directory-result', requestId, path: absolutePathOrNull }` | Settles that pending native picker |
| `{ type: 'shutdown' }` | `{ type: 'shutdown-complete' }`, then IPC disconnect |

The child requests native dialogs with `{ type: 'directory-pick', requestId }` and cancels them with `{ type: 'directory-cancel', requestId }`. Only one dialog may be pending. Call failures return `{ type: responseType, requestId, error }`, using `enrolled` for enrollment failures. Invalid commands and duplicate ids are ignored. The parent validates complete reply fields, correlation and loopback authority; malformed replies fail the owned connection. Startup, runtime, and reported teardown failures emit `{ type: 'fatal', message }`; a failed stop never emits `shutdown-complete`.

Enrollment is an explicit local action. The shell creates a P-256 keypair and supplies only its canonical base64url DER SPKI public key. The Host creates and approves exactly that request and records its public key, enrollment id, Grant id and revision in an owner-only `.desktop-device.json` receipt. It accepts no caller-supplied pending enrollment id and no replacement key. Later boots restore that exact association and recheck the live Grant; revocation, expiry and unavailable authentication never recreate authority. The browser must reuse its stored non-exportable device and the ordinary `/auth/challenge` and `/auth/exchange` flow. Recovery uses ordinary authentication approval. The Host returns no bearer credential and exposes no public bootstrap bypass.

Activity is `{ status: 'unknown' }` before enrollment or on authentication/service loss. Otherwise it reports `{ status: 'idle' | 'active', sessions, tasks }` from existing session status, `terminal/list`, `scheduler/listAll`, and admitted HTTP mutations. It does not attach cold sessions. Active schedules count as pending work because they can admit autonomous work; an update lock therefore requires them to be paused or completed. A successful `lock` returns `active: false`, and all new HTTP/upgrade admissions return 503 until `unlock` or shutdown.

Shutdown closes admission, settles private enrollment/update operations, closes live Agents through their registry lifecycle to release scheduler idle waits, and awaits root fiber disposal, including scheduler and terminal effects. Only then does it acknowledge and disconnect. Parent disconnect and process signals follow the same owned teardown path. The parent adapter requires acknowledgement plus zero-status actual process `close`, and rejects forced termination, missing acknowledgement and nonzero exit. Startup and request deadlines default to 60 and 10 seconds; shutdown allows 15 seconds, then 5 seconds each after SIGTERM and SIGKILL. Timers clear on settlement. `hasClosed()` supplies separate evidence for an explicit Quit/disconnect recovery decision; it does not make an unsuccessful `stop()` safe for updates.

## Focused verification

From this directory, after workspace dependencies and their runtime artifacts are available:

```sh
node ../../node_modules/tsdown/dist/run.mjs
node ../../node_modules/vitest/vitest.mjs run apps/desktop-host/tests --root ../.. --maxWorkers=1
```

The built-process tests relocate this app beside the CLI dependency closure, boot isolated real profiles with no model credentials (including an empty PATH), complete device enrollment and browser-session challenge exchange, call the authenticated `session.list` API, and verify actual process close. A second process test exercises the production parent adapter's enrollment, update admission and shutdown replies. Unit and Loader tests cover strict validation, deadlines, home preservation, disabled profile rows, device restoration and revocation, native picker correlation, and a real scheduler waiting on Agent idle. Tests close every owned instance and remove only their temporary homes.
