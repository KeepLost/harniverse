---
name: diagnose-windows-sandbox-acl
description: 'Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail, or an ordinarily readable path cannot be read. Two steps share one bundled scan: a confined read-only command inspects the path and every ancestor, reports the ACL problems it proves, and prints the exact repair command; after separate approval, that command runs unconfined with -Repair to apply and verify the repairs. Expected confinement denials need no ACL repair.'
---

# Diagnose Windows sandbox ACL failures

**Write every approval request in plain words, in the user's language.** The prompt is all the user reads before widening access, so it must stand alone: which folder the script touches, that the repair adds the signed-in user's full-control entry where a right is missing and removes foreign package entries, that file contents and owners are unchanged, and that the printed recovery command undoes each change. Keep error codes, `WRITE_DAC`/`WRITE_OWNER`, `S-1-15-2-*` SIDs, `icacls`, ACL, ACE, verdict names and switches out of the request: write Windows file permissions, not ACL or ACE. One approval per step: the confined diagnosis is the tool call itself; the repair asks once, for one command.

## Two steps over one scan

One scan reads the path and every ancestor, classifies it, and collects the repairs the observations prove. Without `-Repair` nothing is written except the report; with `-Repair` the same scan runs again and then applies exactly what it proves:

- directories on that chain that lack effective `WRITE_DAC` or `WRITE_OWNER` receive a full-control allow ACE for the signed-in user, because DSH cannot provision its workspace grant without them;
- explicit AppContainer package allow ACEs (`S-1-15-2-*`, except the well-known groups ending in 1 or 2) are removed at their sources, ancestor first, which also removes those packages' access;
- a directory the sandbox cannot provision — the state its provisioning error reports on the workspace root — or the authorized root itself also has its subtree searched for those ACEs in the same run. That bounded walk reports `truncated` and unreadable directories; if truncated, pass the still-failing deeper path once more.

Step 1, confined (read-only: the confined token can read the permissions, and `-Out` must be a workspace-writable path inside the failing workspace so the report can be written):

```powershell
& '<skill-directory>\scripts\diagnose-windows-sandbox-acl.ps1' -Path '<failing-path>' -AllowRoot '<authorized-directory>' -Out '<workspace-writable-directory>'
exit $LASTEXITCODE
```

Step 2, after the diagnosis proves repairs and the user approves, runs unconfined — the exact `REPAIR_COMMAND` the diagnosis printed:

```powershell
& '<skill-directory>\scripts\diagnose-windows-sandbox-acl.ps1' -Path '<failing-path>' -AllowRoot '<authorized-directory>' -Out '<recovery-directory>' -Repair
exit $LASTEXITCODE
```

Substitute full, quoted paths. Keep `-Out` persistent and user-owned: inside the failing workspace for step 1, preferably beside it for step 2 (which also receives the recovery artifacts); never the skill resource directory, deleted when the skill unloads. One path per invocation; never merge the two steps into one approval or pass a switch that does not exist.

`-AllowRoot` bounds every change: an object is changed only when it is that directory or strictly inside it, so a workspace root can repair itself. Every change is backed up, then verified by re-reading it.

## Run it

Repeat the failing operation once confined, then run step 1 confined: it only reads permissions and writes its report inside the workspace. The repair writes permissions, which the confined token cannot — so step 2 asks approval for that one command and runs it unconfined. Unconfined does not elevate the Windows token.

Diagnose unexpected denials of workspace writes, listing, or plainly readable paths; explain expected ones instead: writes outside the workspace, any write in `read-only`, piped grandchild `spawn EPERM`, ConstrainedLanguage errors. If approval is refused or unavailable, report the path as undiagnosed and stop.

## Read the output

Every record reaches stdout, the `acl-report-*.jsonl` file under `-Out`, and the final `RECAP` line, which carries the verdicts, planned or applied changes, verifications, refusals and scans. Tool output keeps only its tail, so read the recap first, and read specific records from the report when it is not enough. Trust `verification` records, never `completed` actions. Decide from `details.nextAction`:

| `nextAction` | Meaning |
|---|---|
| `run_repair_command` | Diagnosis proved repairs; ask for approval, then run the printed repair command unconfined. |
| `verify_original_confined_operation` | Repairs verified; repeat the original operation confined. |
| `stop` | Nothing to repair, or a refusal ended the run. Report and stop. |
| `restore_pending_then_stop` | Rollback unverified. Run the printed recovery commands in order, then stop. |

A deny ACE's presence alone does not establish causation, and the script never removes one; DSH's `S-1-4-*` grants and the Everyone `DeleteSubdirectoriesAndFiles` deny are expected, not conflicts. A deny that blocks the repair ends the run without a repair (`REPAIR_REFUSED`, or `GRANT_FAILED`) after restoring what it attempted. Each change leaves two files in `-Out` (`acl-backup-<id>.json` and its `.ps1`), and the run prints the matching `ROLLBACK` command.

## After a repair, and when it stops

Repeat the original failed operation confined. A verified repair is not undone because the original operation fails for a further reason: continue from the new observations, and if a deeper path is still denied, run step 1 there again, then its step 2 — one approval per step.

**Stop after any failed or refused repair, or failed verification.** The script already restored that invocation's changes; do not repeat it or start another repair, and never remove a deny ACE by hand.

**A stopped run still owes the user a decision.** Name the blocking object and the right or ACE it lacks, what changed and what was rolled back, the recovery commands in order, and the report path — the report file stays on disk for the owner; nothing is uploaded. Only the user can lift confinement, so ask them to switch this session to **full access** (Chinese UI: 完全权限) temporarily, and say what that opens: keep working under it, or ask you to keep investigating this file-permission problem, since the report already records the mechanism and the evidence. For example:

> 这个工作区被 Windows 文件权限挡住了：`<对象>` 上 `<缺哪个权限 / 哪条权限项>`。你可以把本会话切到「完全权限」(full access) 临时继续工作；切完之后既能直接干活，也可以让我继续排查这个文件权限问题（报告已经留在磁盘上，里面有机制和证据）。
>
> This workspace is blocked by Windows file permissions: `<object>` `<missing right / offending entry>`. Switch this session to full access (完全权限) to keep working meanwhile; then either continue your work or have me keep investigating this file-permission problem — the report stays on disk with the mechanism and the evidence.

## Never

- edit ACLs by hand, change an owner, erase a deny, or replace child permissions recursively;
- run the script elevated, through UAC or `runas`;
- widen `-AllowRoot` to reach an ancestor, or repeat a denied or failed call.

Report in the user's language: analyzed paths, planned or applied changes, verification, recovery commands, next step. Label an authorized unconfined run as such, not as a sandbox repair.
