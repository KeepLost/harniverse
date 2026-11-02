//! Exec operations: spawn guest processes (plain pipes or a pty), forward
//! their streams as base64 `exec.out` frames, deliver stdin and signals, and
//! report exits. All replies funnel through one locked port writer so frames
//! from concurrent pump threads never interleave.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;

use super::proto::{PtySize, Reply, MAX_DATA_BYTES};

/// Serialized frame writer shared by the main loop and every pump thread.
pub type Sink = Arc<Mutex<File>>;

/// Chunk size the stream pumps read per frame; base64 inflates it by 4/3,
/// staying well under the frame ceiling.
const STREAM_CHUNK: usize = 32 * 1024;

enum StdinTarget {
    Pipe(std::process::ChildStdin),
    Master(File),
}

struct ExecEntry {
    pid: u32,
    stdin: Option<StdinTarget>,
}

/// Live execs keyed by host-assigned id.
#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<u64, ExecEntry>>,
}

fn signal_number(name: &str) -> Option<i32> {
    match name {
        "SIGKILL" => Some(libc::SIGKILL),
        "SIGTERM" => Some(libc::SIGTERM),
        "SIGINT" => Some(libc::SIGINT),
        "SIGHUP" => Some(libc::SIGHUP),
        "SIGQUIT" => Some(libc::SIGQUIT),
        "SIGUSR1" => Some(libc::SIGUSR1),
        "SIGUSR2" => Some(libc::SIGUSR2),
        _ => None,
    }
}

fn signal_name(number: i32) -> Option<&'static str> {
    match number {
        libc::SIGKILL => Some("SIGKILL"),
        libc::SIGTERM => Some("SIGTERM"),
        libc::SIGINT => Some("SIGINT"),
        libc::SIGHUP => Some("SIGHUP"),
        libc::SIGQUIT => Some("SIGQUIT"),
        libc::SIGUSR1 => Some("SIGUSR1"),
        libc::SIGUSR2 => Some("SIGUSR2"),
        _ => None,
    }
}

fn reply(sink: &Sink, message: &Reply) {
    let payload = serde_json::to_vec(message).unwrap_or_default();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    if let Ok(mut port) = sink.lock() {
        let _ = port.write_all(&frame);
    }
}

/// Reject requests carrying bytes a pathname or environment entry cannot
/// hold; wire inputs are untrusted until shaped.
fn contains_nul(value: &str) -> bool {
    value.contains('\0')
}

fn default_env() -> HashMap<String, String> {
    HashMap::from([
        ("PATH".to_string(), "/bin:/usr/bin:/sbin:/usr/sbin".to_string()),
        ("HOME".to_string(), "/".to_string()),
        ("TERM".to_string(), "dumb".to_string()),
    ])
}

fn pump_stream(stream: impl Read, sink: Sink, id: u64, label: &'static str) {
    let mut reader = stream;
    let mut buffer = vec![0u8; STREAM_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer[..n]);
                reply(&sink, &Reply::ExecOut { id, s: label, d: encoded });
            }
            Err(_) => return,
        }
    }
}

/// Wait for the child, then drain every stream pump, and only then report
/// the exit: output frames must never land after the exit frame.
fn watch_exit(mut child: Child, sink: Sink, id: u64, registry: Arc<Registry>, pumps: Vec<thread::JoinHandle<()>>) {
    let status = match child.wait() {
        Ok(status) => status,
        Err(_) => return,
    };
    for pump in pumps {
        let _ = pump.join();
    }
    if let Ok(mut entries) = registry.entries.lock() {
        entries.remove(&id);
    }
    let (code, sig) = match status.signal() {
        Some(number) => (128 + number, signal_name(number)),
        None => (status.code().unwrap_or(-1), None),
    };
    reply(&sink, &Reply::ExecExit { id, code, sig });
}

fn spawn_pipes(
    mut command: Command,
    sink: &Sink,
    id: u64,
    registry: &Arc<Registry>,
) -> Result<(), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let mut pumps = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let out_sink = Arc::clone(sink);
        pumps.push(thread::spawn(move || pump_stream(stdout, out_sink, id, "o")));
    }
    if let Some(stderr) = child.stderr.take() {
        let err_sink = Arc::clone(sink);
        pumps.push(thread::spawn(move || pump_stream(stderr, err_sink, id, "e")));
    }
    let stdin = child.stdin.take().map(StdinTarget::Pipe);
    registry
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?
        .insert(id, ExecEntry { pid, stdin });
    thread::spawn({
        let sink = Arc::clone(sink);
        let registry = Arc::clone(registry);
        move || watch_exit(child, sink, id, registry, pumps)
    });
    reply(sink, &Reply::ExecStarted { id, pid });
    Ok(())
}

fn spawn_pty(
    mut command: Command,
    size: &PtySize,
    sink: &Sink,
    id: u64,
    registry: &Arc<Registry>,
) -> Result<(), String> {
    let winsize = libc::winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // SAFETY: openpty(3) filling our own out-params; the slave becomes the
    // child's controlling terminal via the pre_exec hook below.
    let rc = unsafe {
        libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &winsize)
    };
    if rc != 0 {
        return Err(format!("openpty failed with rc {rc}"));
    }
    let slave_fd = slave;
    // SAFETY: fd ownership transfers into Stdio, which closes it after the
    // spawn settles; three dups feed stdin/stdout/stderr of the child.
    let slave_stdin = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(slave_fd)) };
    let slave1 = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(slave_fd)) };
    let slave2 = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(slave_fd)) };
    // SAFETY: the original slave fd is consumed as the dup source above; its
    // final copy becomes stdin. Closing the source after dup is automatic:
    // from_raw_fd hands each dup to Stdio, which closes them post-exec.
    drop(unsafe { File::from_raw_fd(slave_fd) });
    // SAFETY: master ownership transfers here; clones below feed the pump and
    // the stdin target.
    let master_file = unsafe { File::from_raw_fd(master) };
    command.stdin(Stdio::from(slave_stdin));
    command.stdout(Stdio::from(slave1));
    command.stderr(Stdio::from(slave2));
    // SAFETY: pre_exec itself is an unsafe interface; the closure body uses
    // only async-signal-safe calls, and fd 0 is the pty slave by then.
    unsafe {
        command.pre_exec(|| {
            // SAFETY: async-signal-safe session setup on the child side.
            libc::setsid();
            libc::ioctl(0, libc::TIOCSCTTY, 0 as libc::c_ulong);
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let mut pumps = Vec::new();
    if let Ok(pump_master) = master_file.try_clone() {
        let pump_sink = Arc::clone(sink);
        pumps.push(thread::spawn(move || pump_stream(pump_master, pump_sink, id, "o")));
    }
    registry
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?
        .insert(id, ExecEntry { pid, stdin: Some(StdinTarget::Master(master_file)) });
    thread::spawn({
        let sink = Arc::clone(sink);
        let registry = Arc::clone(registry);
        move || watch_exit(child, sink, id, registry, pumps)
    });
    reply(sink, &Reply::ExecStarted { id, pid });
    Ok(())
}

/// Handle one `exec` request end to end.
pub fn start(
    sink: &Sink,
    registry: &Arc<Registry>,
    id: u64,
    argv: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    pty: Option<PtySize>,
) {
    if argv.is_empty() || argv.iter().any(|arg| arg.is_empty() || contains_nul(arg)) {
        reply(sink, &Reply::ExecErr { id, message: "argv must be non-empty strings".to_string() });
        return;
    }
    if let Some(env) = env.as_ref() {
        if env.iter().any(|(key, value)| key.is_empty() || contains_nul(key) || contains_nul(value)) {
            reply(sink, &Reply::ExecErr { id, message: "env entries must be NUL-free".to_string() });
            return;
        }
    }
    if let Some(cwd) = cwd.as_deref() {
        if !cwd.starts_with('/') || contains_nul(cwd) {
            reply(sink, &Reply::ExecErr { id, message: "cwd must be an absolute path".to_string() });
            return;
        }
    }
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]);
    command.env_clear();
    command.envs(env.unwrap_or_else(default_env));
    command.current_dir(cwd.as_deref().unwrap_or("/"));
    let outcome = match pty.as_ref() {
        Some(size) => spawn_pty(command, size, sink, id, registry),
        None => spawn_pipes(command, sink, id, registry),
    };
    if let Err(message) = outcome {
        reply(sink, &Reply::ExecErr { id, message });
    }
}

/// Handle one `exec.stdin` chunk: decode, forward, drop the pipe on error.
pub fn stdin(registry: &Arc<Registry>, id: u64, data: &str) {
    let decoded = match base64::engine::general_purpose::STANDARD.decode(data) {
        Ok(decoded) if decoded.len() <= MAX_DATA_BYTES => decoded,
        _ => return,
    };
    if let Ok(mut entries) = registry.entries.lock() {
        if let Some(entry) = entries.get_mut(&id) {
            match entry.stdin.as_mut() {
                Some(StdinTarget::Pipe(stdin)) => {
                    if stdin.write_all(&decoded).is_err() {
                        entry.stdin = None;
                    }
                }
                Some(StdinTarget::Master(master)) => {
                    let _ = master.write_all(&decoded);
                }
                None => {}
            }
        }
    }
}

/// Handle `exec.stdin.close`: dropping the target ends the child's stdin.
pub fn stdin_close(registry: &Arc<Registry>, id: u64) {
    if let Ok(mut entries) = registry.entries.lock() {
        if let Some(entry) = entries.get_mut(&id) {
            entry.stdin = None;
        }
    }
}

/// Handle `exec.signal`: deliver to the live pid, or answer the error reply.
pub fn signal(sink: &Sink, registry: &Arc<Registry>, id: u64, name: &str) {
    let Some(number) = signal_number(name) else {
        reply(sink, &Reply::ExecErr { id, message: format!("unsupported signal {name}") });
        return;
    };
    let pid = registry
        .entries
        .lock()
        .ok()
        .and_then(|entries| entries.get(&id).map(|entry| entry.pid));
    match pid {
        Some(pid) => {
            // SAFETY: kill(2) on the recorded child pid.
            let rc = unsafe { libc::kill(pid as libc::pid_t, number) };
            if rc == 0 {
                reply(sink, &Reply::ExecAcked { id });
            } else {
                reply(sink, &Reply::ExecErr { id, message: format!("kill failed with rc {rc}") });
            }
        }
        None => reply(sink, &Reply::ExecErr { id, message: "no such exec".to_string() }),
    }
}
