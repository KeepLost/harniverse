//! In-world confinement wrapper: applies a Landlock ruleset to itself, then
//! `execvp`s the caller's argv unchanged — the wrapped command runs under
//! kernel-enforced file effects with no runner process left in between.
//! Invoked by the host's sandbox provider as
//! `/bin/dsh-vm-confine --ro ROOT... --rw ROOT... -- argv...`; every
//! failure before exec prints one `dsh-vm-confine:` stderr line and exits
//! nonzero (2 usage, 3 Landlock, 127 exec), so a runner failure is
//! distinguishable from a confined command's own exit.

use std::ffi::CString;

use dsh_vm_guest_agent::landlock;

fn usage(message: &str) -> ! {
    eprintln!("dsh-vm-confine: {message}");
    eprintln!("usage: dsh-vm-confine [--ro ROOT]... [--rw ROOT]... -- ARGV...");
    std::process::exit(2);
}

struct Grants {
    read_only: Vec<String>,
    read_write: Vec<String>,
}

fn parse(args: &[String]) -> Result<(Grants, Vec<String>), String> {
    let mut grants = Grants { read_only: Vec::new(), read_write: Vec::new() };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--ro" | "--rw" => {
                let root = args.get(index + 1).ok_or_else(|| format!("{} requires a path", args[index]))?;
                if !root.starts_with('/') {
                    return Err(format!("grant root must be absolute: {root}"));
                }
                if args[index] == "--ro" {
                    grants.read_only.push(root.clone());
                } else {
                    grants.read_write.push(root.clone());
                }
                index += 2;
            }
            "--" => {
                let argv = args[index + 1..].to_vec();
                if argv.is_empty() || argv.iter().any(|arg| arg.is_empty()) {
                    return Err("the command after -- must be non-empty strings".to_string());
                }
                return Ok((grants, argv));
            }
            other => return Err(format!("unexpected argument: {other}")),
        }
    }
    Err("missing -- before the command".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (grants, argv) = match parse(&args) {
        Ok(parsed) => parsed,
        Err(message) => usage(&message),
    };
    if let Err(message) = landlock::restrict(&grants.read_only, &grants.read_write) {
        eprintln!("dsh-vm-confine: {message}");
        std::process::exit(3);
    }
    let program = match CString::new(argv[0].as_str()) {
        Ok(program) => program,
        Err(_) => usage("the command contains NUL"),
    };
    let cargv: Vec<CString> = argv
        .iter()
        .map(|arg| CString::new(arg.as_str()))
        .collect::<Result<_, _>>()
        .unwrap_or_else(|_| usage("the command contains NUL"));
    let mut pointers: Vec<*const libc::c_char> = cargv.iter().map(|arg| arg.as_ptr()).collect();
    pointers.push(std::ptr::null());
    // SAFETY: execvp(3) replaces this process with the confined command; it
    // returns only on failure.
    if unsafe { libc::execvp(program.as_ptr(), pointers.as_mut_ptr()) } != 0 {
        eprintln!("dsh-vm-confine: cannot execute {}: {}", argv[0], std::io::Error::last_os_error());
        std::process::exit(127);
    }
    unreachable!("execvp returned success");
}
