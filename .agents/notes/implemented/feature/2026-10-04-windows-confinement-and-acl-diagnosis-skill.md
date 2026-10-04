# Agent Note: Windows enrolled-workspace confinement and the two-step ACL diagnosis skill

Status: implemented

English | [中文](2026-10-04-windows-confinement-and-acl-diagnosis-skill.zh.md)

Scope: `packages/sandbox/sandbox-windows-acl` (`src/token.ts`, `src/acl.ts`, `src/grant.ts`, `src/index.ts`, `src/runner.ts`, `src/acl-skill.ts`, `assets/diagnose-windows-sandbox-acl/`), `packages/sandbox/sandbox-local` (`Config.confinedWorkspaces` and the skills wiring in `src/index.ts`)

## Problem

Official-sync blueprint rows R15/R16 (item X10): upstream lowers its Windows ACL backend to Low integrity unconditionally — every confined run rewrites the workspace's SACL — and bundles a one-command skill that diagnoses and repairs ACL problems in a single approved unconfined run, then asks the user to send the session as feedback. Both shapes collide with Harniverse contracts. The [ACL backend's design](2026-08-08-windows-acl-restricted-token-sandbox.md) had shipped with standing reuse ACEs on operator-owned workspaces, so an unconditional label apply would persistently mutate every existing workspace's security descriptor on its next grant; and our approval discipline separates read-only observation from permission-widening writes. The write-restricted intersection also left two documented holes unaddressed: deletes authorized through the parent directory's `FILE_DELETE_CHILD` right, and ambient-DACL writes (Everyone, hard links) into objects the token's own level would protect.

## Decision

- **Enrollment is opt-in per workspace.** `dsh-sandbox-local`'s `confinedWorkspaces` config (default `[]`) lists absolute workspace roots, compared case-insensitively (both sides lowercased) against the session's resolved root; relative or empty entries fail at construction. Unenrolled roots keep the pre-enrollment backend byte-for-byte: no `--low-integrity` in the runner argv, DACL-only applies, no label machinery.
- **Token half.** `restrictTokenIntegrity` (`src/token.ts`) lowers the restricted token to Low integrity (`S-1-16-4096` via `SetTokenInformation`/`TokenIntegrityLevel` with `SE_GROUP_INTEGRITY`), closing the ambient-DACL hole: a Low token cannot write up into medium-integrity objects even where an Everyone grant would allow the write. Exposed as the `AclSandbox` option `lowIntegrity` and the runner flag `--low-integrity` (both modes); fails closed like every token edit in the module.
- **Grant half — one merge.** On an enrolled root every grant applies, in the same single `SetNamedSecurityInfoW` call: the capability ACE, a standing inheritable Low no-write-up mandatory label on the directory's SACL (`AddMandatoryAce`, `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`), and a container-inherited Everyone deny of `FILE_DELETE_CHILD` — so the capability ACE's own DELETE bit becomes the only delete authority inside the root. The deny inherits to containers only: the right is evaluated on directories, and inheriting its bit onto files would deny every `FILE_ALL_ACCESS`/`GENERIC_ALL` open inside the root. `AclWriteGrant.create(sid, { confined: true })` carries the `lowLabelSid`/`worldSid` pair for seam-side materialization.
- **Persistent effects and the upgrade path.** The label and deny are standing directory mutations that survive the process by design — the same reuse cache as the capability ACE. Un-enrolling stops NEW grants from carrying them but removes nothing already standing; a confined revoke clears the label only when no other capability grant remains on the directory. The idempotent skip requires the exact ACE, deny, AND label together, so a legacy-era standing grant receives the label and deny on its next confined provision without re-propagating the tree. Confined grants additionally require `WRITE_OWNER` on the granted directory (the label lives in the SACL; owner-implicit rights cover only `READ_CONTROL` and `WRITE_DAC`) — a Full-control workspace directory, the normal case, satisfies both.
- **Two-step diagnosis skill.** `diagnose-windows-sandbox-acl` (`assets/…/SKILL.md` + `scripts/diagnose-windows-sandbox-acl.ps1`) registers with the skill registry through a win32-gated `ctx.inject(['skills'])` (only when no operator `runnerCommand` overrides the backend). Step 1 is the confined, read-only tool call — the report is written inside the workspace; step 2 runs the printed `REPAIR_COMMAND` with `-Repair` unconfined under its own approval. Expected confinement denials are explained, not repaired; every change is backed up and verified by re-reading; a stopped run still owes the user a decision.

## Deviations from official

- **Gated vs unconditional confinement.** Official applies the Low label to every confined run (its sandbox-local exposes no enrollment config); Harniverse gates token lowering and the label/deny edits on `confinedWorkspaces`, because the effects are persistent mutations of operator-owned directories.
- **Two steps vs one approved run.** Official's skill has no modes — one approved unconfined command diagnoses and repairs in the same run; ours runs the diagnosis confined as the tool call itself and asks for a separate approval only when the diagnosis proves a repair, because a permission-widening write deserves its own approval.
- **No feedback upload.** Official's skill asks the user to send the session as feedback; ours uploads nothing — the report file stays on disk for the owner.

## Alternatives considered

**Unconditional confinement, as official.** Rejected: the label and deny are standing mutations; silently rewriting the SACL of every existing workspace on its next grant is not Harniverse's call to make — enrollment is the operator's.

**A label without the ambient-delete deny.** Rejected: the parent-directory `FILE_DELETE_CHILD` hole survives integrity labeling; delete authority inside an enrolled root must reduce to the capability ACE.

**A separate label apply call.** Rejected: a second `SetNamedSecurityInfoW` per grant doubles the eager full-tree propagation and makes grant+label non-atomic; one merged apply carries the DACL and SACL edits together.

**Clearing the label on every confined revoke.** Rejected: another capability grant may still stand on the same directory; clearing then would strip the label the remaining grant's writes depend on, so the label leaves only with the last capability grant.

**A single approved run, as official's skill.** Rejected: the confined, read-only diagnosis needs no widened authority; folding repair into it would make one approval cover both observation and permission-widening writes.

## Consequences

Enrolled workspaces get the two missing delete and ambient-DACL protections (a Low token plus a root whose only delete authority is the capability ACE), at the cost of persistent SACL/DACL mutations the operator opted into and cannot fully undo by un-enrolling (a re-provision after un-enrollment leaves the standing entries; the label clears only with the last capability revoke). Legacy deployments notice nothing until they enroll. The diagnosis skill keeps observation inside the sandbox and widens authority only per repaired run, with the report retained locally instead of uploaded.

## Verification

- `packages/sandbox/sandbox-windows-acl/tests/acl-confinement.spec.ts`: the confined grant merges deny+label with the capability ACE in one DACL+LABEL apply; a legacy grant stays byte-identical DACL-only; the idempotent skip requires grant+deny+label; the legacy-era standing grant upgrade path; a confined revoke clears the label only with the last capability grant and keeps it while a foreign grant remains; a legacy revoke never touches labels.
- `token-failure-paths.spec.ts` / `grant-failure-paths.spec.ts`: the new Win32 calls fail closed with named errors.
- `acl-skill.spec.ts`, `skill-composition.spec.ts`, `diagnose-script.spec.ts`: registry registration and HMR disposal, the packaged body through a real composition, `-Repair` as the only mutation gate, retention of the one-run original's bounding and rollback machinery, and the two-step flow documented without any upload request.
- `packages/sandbox/sandbox-local/tests/acl-grants.spec.ts`: default config stays unconfined (no `--low-integrity`, legacy grants — off by default); an enrolled workspace confines across every policy shape with grants created confined; an unenrolled sibling stays unconfined; a relative `confinedWorkspaces` entry fails at construction.
- Real-kernel proof stays with the win32 lanes: the `windows-native` job (`check:ci:windows-complete`) and the wine lane (`check:windows-wine`).
