# Agent Note: Enrollment invitations redeem pre-issued approvals on the authentication gate

Status: implemented

English | [中文](2026-09-18-enrollment-invitation.zh.md)

- Date: 2026-09-18
- Scope: `@deepseek-ai/dsh-authentication` (seam), `@deepseek-ai/dsh-authentication-local` (registry + provider), `@deepseek-ai/dsh-auth-app` (CLI), `@deepseek-ai/dsh-client-connection` (route), `@deepseek-ai/dsh-client-web` (gate UI)
- PR: pending (this note ships with the feature)

## Problem

First-run onboarding required the owner at a terminal: a new browser submitted an enrollment request and waited for `dsh auth device approve`. A helper setting up a kiosk or borrowing the instance for an hour either needed shell access on the host or needed the owner to watch the pending queue. The gate had no way to carry an approval that was decided in advance.

## Decision

An invitation is a pre-issued approval, not a new authentication method.

1. **The seam classifies redemption as an approval path.** `redeemEnrollmentInvitation(id, invitation, peerAddress?)` joins the abstract service next to `approveEnrollment` and returns `AuthenticationInvitationDecision`: the same approved receipt on success, or one of six stable rejection reasons (`invalid-invitation`, `invitation-kind`, `invitation-name`, `not-found`, `rate-limited`, `authentication-unavailable`).
2. **The registry stores invitations in the same `grants.json` under the same lock.** Records carry a SHA-256 `codeHash` — the `dshi1_` token never rests on disk — plus a capability ceiling, `device|temporary` kind, optional `bindName`, and `active|used` state. `redeemEnrollmentInvitation` marks the token used and creates the Grant in one `mutateRegistry` transaction, so replay after success is an `invalid-invitation`. Lifetime is capped at 7 days, active invitations at 64, and settled records prune lazily after a 7-day audit window.
3. **Rate limiting counts only invalid tokens.** Redemption shares the provider's invalid-credential limiter keyed `invitation-redeem:<peer>`, and only the `invalid-invitation` reason counts: a holder who pastes a wrong-kind or name-conflicting token is correcting themselves, not attacking. Kind rejections return the `expected` kind so the UI can name the right button; bind-name rejections confirm occupancy without revealing the bound name.
4. **Same-key pending replacement closes a retry trap.** A browser that re-submits enrollment while its own request pends (previously a name conflict against itself) atomically supersedes that pending under the same lock: fresh id and approval code, name freed. Name conflicts remain only against other keys' pendings and Grants.
5. **The CLI issues, lists, and revokes.** `dsh auth code issue --profile|--capability --ttl [--count] [--kind] [--bind]` prints each token exactly once in a TSV-leading column; `code list` shows ids, state, and ceilings without tokens; `code revoke` retires an active invitation.
6. **The gate redeems from both screens.** The enrollment form gains an optional invitation field (paste-tolerant normalization takes the first whitespace-separated token; format failures never reach the network), and the pending screen gains a divider-separated block so a request already waiting can still be redeemed. On 409/404 failures a 「重新配对」 escape hatch clears the stored device identity while keeping the retained key in memory, so a retry re-enrolls the same browser key instead of minting a second one; a late redemption response arriving after polling approved is dropped by a pending-id guard.

## Consequences

- An owner can hand a bounded, expiring, single-use capability to a helper without host access; temporary-kind invitations keep the 60-minute/15-minute idle shape of temporary devices.
- Replay of a redeemed token is indistinguishable from an unknown token (uniform `invalid-invitation`), and its repeated use trips the same limiter as password guessing.
- The registry format grows an optional `invitations` list; parse accepts its absence and write always includes it, so older files load unchanged.
- `/auth/manage` does not issue invitations (CLI only) and there is no `dsh auth device deny` yet; both are deferred below.

## Alternatives considered

- **A separate invitations file:** rejected — redemption must be atomic with Grant creation and owner sealing; a second file would need its own cross-process lock and crash-consistency story.
- **Plaintext token storage for CLI redisplay:** rejected — the token is a bearer capability; `code list` never needs it back, and `issue` prints it exactly once.
- **Counting every failed redemption toward the limiter:** rejected — kind and name failures carry actionable recovery on the gate screen; punishing them would lock out a legitimate holder who pasted into the wrong mode.
- **Time-limited approval codes on pending requests (TOTP-style):** deferred — a second clock-coupled mechanism on the approval path; pre-issued hashed tokens cover the same owner-intent case with fewer moving parts.

## Known limitations

- Refreshing during the 409 recovery path drops the retained key (memory-only by design, like temporary credentials); the browser starts a genuinely fresh enrollment.
- `dsh auth device deny` for discarding an unwanted pending request is still missing; same-key resubstitution covers only the requester's own pending.
