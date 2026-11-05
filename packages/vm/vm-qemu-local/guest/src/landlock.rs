//! In-guest Landlock confinement, shared by the agent's boot-time
//! self-probe and the `dsh-vm-confine` wrapper: read-only roots grant
//! execute/read, read-write roots grant every access the running kernel's
//! ABI can govern, a non-directory grant keeps only the file-compatible
//! bits (how the `/dev/null` grant works), and an unopenable grant root
//! fails closed rather than silently narrowing the profile. The semantics
//! mirror the host launcher (`native/landlock-run`) so the two dialects
//! cannot drift apart. The guest kernel (Alpine `virt` 6.6) tops out at
//! Landlock ABI 3; newer access bits stay masked off until it is upgraded.

use std::ffi::CString;

pub const ACCESS_EXECUTE: u64 = 1 << 0;
pub const ACCESS_WRITE_FILE: u64 = 1 << 1;
pub const ACCESS_READ_FILE: u64 = 1 << 2;
pub const ACCESS_READ_DIR: u64 = 1 << 3;
const ABI1_MASK: u64 = (1 << 13) - 1;
const ACCESS_REFER: u64 = 1 << 13;
const ACCESS_TRUNCATE: u64 = 1 << 14;
const CREATE_RULESET_VERSION: libc::c_ulong = 1 << 0;
const RULE_PATH_BENEATH: libc::c_long = 1;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

#[repr(C)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: libc::c_int,
}

/// The read-side access set a read-only root grants.
const READ_SIDE: u64 = ACCESS_EXECUTE | ACCESS_READ_FILE | ACCESS_READ_DIR;
/// The access set a non-directory grant may carry (the kernel rejects
/// directory-only accesses on a file rule).
const FILE_SIDE: u64 = ACCESS_EXECUTE | ACCESS_WRITE_FILE | ACCESS_READ_FILE | ACCESS_TRUNCATE;

fn errno_message(operation: &str) -> String {
    let code = unsafe { *libc::__errno_location() };
    format!("{operation} failed with errno {code}")
}

/// Report the running kernel's Landlock ABI, or -1 when Landlock is off.
pub fn probe_abi() -> i32 {
    // SAFETY: create_ruleset with a NULL attr and the VERSION flag only
    // reports the ABI; it installs no ruleset.
    let abi = unsafe {
        libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<RulesetAttr>(), 0usize, CREATE_RULESET_VERSION)
    };
    abi as i32
}

fn handled_mask(abi: i32) -> u64 {
    let mut mask = ABI1_MASK;
    if abi >= 2 {
        mask |= ACCESS_REFER;
    }
    if abi >= 3 {
        mask |= ACCESS_TRUNCATE;
    }
    mask
}

fn add_rule(ruleset_fd: libc::c_int, path: &str, access: u64) -> Result<(), String> {
    let cpath = CString::new(path).map_err(|_| format!("grant path contains NUL: {path}"))?;
    // SAFETY: open(2) with O_PATH|O_CLOEXEC on a caller-supplied path.
    let fd = unsafe { libc::open(cpath.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(format!("cannot open rule path {path}: {}", errno_message("open")));
    }
    let mut allowed = access;
    // SAFETY: fstat(2) on our own fd.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } == 0 && (st.st_mode & libc::S_IFMT) != libc::S_IFDIR {
        allowed &= FILE_SIDE;
    }
    let attr = PathBeneathAttr { allowed_access: allowed, parent_fd: fd };
    // SAFETY: add_rule with our own attr referencing the opened fd.
    let rc = unsafe { libc::syscall(libc::SYS_landlock_add_rule, ruleset_fd as libc::c_long, RULE_PATH_BENEATH, &attr, 0u32) };
    // SAFETY: close(2) on our own fd; the rule holds its own reference.
    unsafe { libc::close(fd) };
    if rc != 0 {
        return Err(errno_message("landlock_add_rule"));
    }
    Ok(())
}

/// Apply a Landlock ruleset to THIS process: read access beneath every
/// read-only root, full governed access beneath every read-write root.
/// The ruleset binds the calling thread, so callers restrict immediately
/// before `exec` in a fresh single-threaded child.
pub fn restrict(read_only: &[String], read_write: &[String]) -> Result<(), String> {
    let abi = probe_abi();
    if abi < 1 {
        return Err(format!("landlock unavailable (kernel abi {abi})"));
    }
    let handled = handled_mask(abi);
    let attr = RulesetAttr { handled_access_fs: handled };
    // SAFETY: create_ruleset with our own attr; the fd is closed below.
    let ruleset = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attr, std::mem::size_of::<RulesetAttr>(), 0u32) };
    if ruleset < 0 {
        return Err(errno_message("landlock_create_ruleset"));
    }
    let ruleset_fd = ruleset as libc::c_int;
    let mut outcome: Result<(), String> = Ok(());
    'grants: for (roots, access) in [(read_only, READ_SIDE & handled), (read_write, handled)] {
        for root in roots {
            if let Err(message) = add_rule(ruleset_fd, root, access) {
                outcome = Err(message);
                break 'grants;
            }
        }
    }
    if outcome.is_ok() {
        // SAFETY: prctl(PR_SET_NO_NEW_PRIVS) on ourselves; required before
        // restrict_self and inherited across exec.
        if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1usize, 0usize, 0usize, 0usize) } != 0 {
            outcome = Err(errno_message("PR_SET_NO_NEW_PRIVS"));
        }
    }
    if outcome.is_ok() {
        // SAFETY: restrict_self binds the ruleset to this thread.
        if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset_fd as libc::c_long, 0u32) } != 0 {
            outcome = Err(errno_message("landlock_restrict_self"));
        }
    }
    // SAFETY: close(2) on our own fd; the restriction already bound.
    unsafe { libc::close(ruleset_fd) };
    outcome
}
