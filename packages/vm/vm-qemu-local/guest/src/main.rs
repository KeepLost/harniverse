//! Guest-side agent for the dsh micro-VM world. Runs as PID 1 from the
//! initramfs, mounts the pseudo filesystems, and serves the versioned
//! control protocol on the second ISA serial (ttyS1; ttyS0 is the console
//! log) until the host shuts the world down. Serial EOF also powers the
//! machine off: a world without its host does not keep running.

mod dataops;
mod exec;
mod fsops;
mod proto;

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::sync::{Arc, Mutex};

use exec::{Registry, Sink};
use proto::{Reply, Request, AGENT_ID, CAPS, CONTROL_PORT, MAX_FRAME_BYTES, PROTOCOL_VERSION};

fn mount(source: &std::ffi::CStr, target: &std::ffi::CStr, fs: &std::ffi::CStr) {
    // SAFETY: mount(2) with properly NUL-terminated static literals; a
    // failure is logged on the console but is otherwise non-fatal (an
    // already-mounted target still leaves the world usable).
    let rc = unsafe {
        libc::mount(source.as_ptr(), target.as_ptr(), fs.as_ptr(), 0, std::ptr::null())
    };
    if rc != 0 {
        let errno = unsafe { *libc::__errno_location() };
        eprintln!("dsh-vm-guest-agent: mount {} rc={} errno={}", target.to_string_lossy(), rc, errno);
    }
}

fn power_off() -> ! {
    unsafe {
        libc::sync();
        libc::reboot(libc::RB_POWER_OFF);
    }
    // reboot(2) as PID 1 must succeed; loop forever if it somehow did not.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

fn try_open_port() -> Option<File> {
    let port = OpenOptions::new().read(true).write(true).open(CONTROL_PORT).ok()?;
    // SAFETY: tcgetattr/cfmakeraw/tcsetattr on our own fd; the tty line
    // discipline must be raw or it echoes and rewrites frame bytes.
    unsafe {
        let mut tio: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(port.as_raw_fd(), &mut tio) == 0 {
            libc::cfmakeraw(&mut tio);
            libc::tcsetattr(port.as_raw_fd(), libc::TCSANOW, &tio);
        }
    }
    Some(port)
}

/// The control serial node exists once the 8250 driver registers it, which can
/// land after PID 1 starts; poll briefly for it.
fn control_port_wait(max_wait: std::time::Duration) -> Option<File> {
    let start = std::time::Instant::now();
    loop {
        if let Some(port) = try_open_port() {
            eprintln!("dsh-vm-guest-agent: control port ready after {}ms", start.elapsed().as_millis());
            return Some(port)
        }
        if start.elapsed() >= max_wait {
            eprintln!("dsh-vm-guest-agent: control port {} not ready within {}ms", CONTROL_PORT, max_wait.as_millis());
            return None
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

fn write_frame(port: &mut File, reply: &Reply) -> bool {
    let payload = serde_json::to_vec(reply).unwrap_or_default();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    port.write_all(&frame).is_ok()
}

fn read_exact_or_eof(port: &mut File, buffer: &mut [u8]) -> bool {
    let mut filled = 0;
    while filled < buffer.len() {
        match port.read(&mut buffer[filled..]) {
            Ok(0) => {
                eprintln!("dsh-vm-guest-agent: control read EOF after {} bytes", filled);
                return false;
            }
            Ok(n) => filled += n,
            Err(error) => {
                eprintln!("dsh-vm-guest-agent: control read error {:?} errno {} after {} bytes", error.kind(), error.raw_os_error().unwrap_or(0), filled);
                return false;
            }
        }
    }
    true
}

/// Handle one decoded request; returns false when the port must be reopened.
fn handle_frame(
    port: &mut File,
    request: Request,
    serving: &mut bool,
    sink: &Sink,
    registry: &Arc<Registry>,
) -> bool {
    match request {
        Request::Hello { v } => {
            if v != PROTOCOL_VERSION {
                write_frame(port, &Reply::Error {
                    code: "version",
                    min_v: PROTOCOL_VERSION,
                    max_v: PROTOCOL_VERSION,
                    message: "protocol version mismatch",
                });
                power_off();
            }
            *serving = true;
            write_frame(port, &Reply::Welcome {
                v: PROTOCOL_VERSION,
                caps: CAPS.to_vec(),
                agent: AGENT_ID,
            })
        }
        Request::Ping { n } => {
            *serving = true;
            write_frame(port, &Reply::Pong { n })
        }
        Request::Shutdown => power_off(),
        Request::Exec { id, argv, env, cwd, pty } => {
            *serving = true;
            exec::start(sink, registry, id, argv, env, cwd, pty);
            true
        }
        Request::ExecStdin { id, d } => {
            exec::stdin(registry, id, &d);
            true
        }
        Request::ExecStdinClose { id } => {
            exec::stdin_close(registry, id);
            true
        }
        Request::ExecSignal { id, sig } => {
            *serving = true;
            exec::signal(sink, registry, id, &sig);
            true
        }
        Request::Fs { id, op } => {
            *serving = true;
            fsops::handle(sink, id, op);
            true
        }
        Request::WorkspaceImport { id } => {
            *serving = true;
            dataops::handle(sink, id, proto::DataOp::Import);
            true
        }
        Request::WorkspaceExport { id } => {
            *serving = true;
            dataops::handle(sink, id, proto::DataOp::Export);
            true
        }
    }
}

/// Serve on one open port. Until the first decoded host frame arrives, keep
/// beaconing `announce` so the host can learn the port is live before it
/// risks writing into the UART. Polling interleaves beacon writes with reads.
fn serve_once(port: &mut File) {
    let writer = match port.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let sink: Sink = Arc::new(Mutex::new(writer));
    let registry = Arc::new(Registry::default());
    let mut serving = false;
    let mut last_beacon = std::time::Instant::now()
        - std::time::Duration::from_secs(1);
    loop {
        if !serving && last_beacon.elapsed() >= std::time::Duration::from_millis(500) {
            if !write_frame(port, &Reply::Announce {
                v: PROTOCOL_VERSION,
                caps: CAPS.to_vec(),
                agent: AGENT_ID,
            }) {
                return
            }
            last_beacon = std::time::Instant::now();
        }
        // SAFETY: poll(2) on our own fd, waiting for readable data.
        let mut pfd = libc::pollfd { fd: port.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let ready = unsafe { libc::poll(&mut pfd, 1, 100) };
        if ready < 0 {
            return
        }
        if ready == 0 {
            continue
        }
        let mut prefix = [0u8; 4];
        if !read_exact_or_eof(port, &mut prefix) {
            return
        }
        let length = u32::from_be_bytes(prefix);
        if length < 1 || length > MAX_FRAME_BYTES {
            return
        }
        let mut payload = vec![0u8; length as usize];
        if !read_exact_or_eof(port, &mut payload) {
            return
        }
        let request: Request = match serde_json::from_slice(&payload) {
            Ok(request) => request,
            Err(_) => {
                if !write_frame(port, &Reply::Error {
                    code: "unknown-message",
                    min_v: PROTOCOL_VERSION,
                    max_v: PROTOCOL_VERSION,
                    message: "unparseable control message",
                }) {
                    return
                }
                continue
            }
        };
        if !handle_frame(port, request, &mut serving, &sink, &registry) {
            return
        }
    }
}

/// Serve until the host asks for shutdown. A serial hangup (a guest port
/// reopened after the UART dropped early host bytes) only ends one serving
/// stint: reopen the port and keep the world alive.
fn serve_forever() -> ! {
    loop {
        let Some(mut port) = control_port_wait(std::time::Duration::from_secs(60)) else {
            power_off()
        };
        serve_once(&mut port);
    }
}

fn main() {
    if std::process::id() == 1 {
        mount(c"devtmpfs", c"/dev", c"devtmpfs");
        let _ = std::fs::create_dir_all("/dev/pts");
        mount(c"devpts", c"/dev/pts", c"devpts");
        mount(c"proc", c"/proc", c"proc");
        mount(c"sysfs", c"/sys", c"sysfs");
        mount(c"tmpfs", c"/tmp", c"tmpfs");
        let _ = std::fs::create_dir_all("/workspace");
        // The workspace data plane rides on virtio-blk, which the virt
        // kernel ships as a module; load it best-effort (an already-loaded
        // module answers with a failure status that is safe to ignore — the
        // workspace ops themselves fail loudly without the device).
        let status = std::process::Command::new("/sbin/insmod")
            .arg("/lib/modules/virtio_blk.ko")
            .status();
        eprintln!("dsh-vm-guest-agent: insmod virtio_blk -> {:?}", status);
    }
    serve_forever()
}
