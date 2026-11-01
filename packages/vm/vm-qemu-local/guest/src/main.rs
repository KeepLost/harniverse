//! Guest-side agent for the dsh micro-VM world. Runs as PID 1 from the
//! initramfs, mounts the pseudo filesystems, and serves the versioned
//! control protocol on the second ISA serial (ttyS1; ttyS0 is the console
//! log) until the host shuts the world down. Serial EOF also powers the
//! machine off: a world without its host does not keep running.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;

use serde::{Deserialize, Serialize};

const PROTOCOL_VERSION: u64 = 1;
const AGENT_ID: &str = concat!("dsh-vm-guest-agent ", env!("CARGO_PKG_VERSION"));
const CONTROL_PORT: &str = "/dev/ttyS1";
const MAX_FRAME_BYTES: u32 = 1 << 20;

#[derive(Serialize)]
#[serde(tag = "t")]
enum Beacon {
    #[serde(rename = "announce")]
    Announce { v: u64, caps: Vec<&'static str>, agent: &'static str },
    #[serde(rename = "welcome")]
    Welcome { v: u64, caps: Vec<&'static str>, agent: &'static str },
    #[serde(rename = "pong")]
    Pong { n: u64 },
    #[serde(rename = "error")]
    Error {
        code: &'static str,
        #[serde(rename = "minV")]
        min_v: u64,
        #[serde(rename = "maxV")]
        max_v: u64,
        message: &'static str,
    },
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum Request {
    #[serde(rename = "hello")]
    Hello { v: u64 },
    #[serde(rename = "ping")]
    Ping { n: u64 },
    #[serde(rename = "shutdown")]
    Shutdown,
}

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

fn write_reply(port: &mut File, reply: &Beacon) -> bool {
    let payload = match serde_json::to_vec(reply) {
        Ok(payload) => payload,
        Err(_) => return false,
    };
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

/// Handle one decoded frame; returns false when the port must be reopened.
fn handle_frame(port: &mut File, request: Request, serving: &mut bool) -> bool {
    match request {
        Request::Hello { v } => {
            if v != PROTOCOL_VERSION {
                write_reply(port, &Beacon::Error {
                    code: "version",
                    min_v: PROTOCOL_VERSION,
                    max_v: PROTOCOL_VERSION,
                    message: "protocol version mismatch",
                });
                power_off();
            }
            *serving = true;
            write_reply(port, &Beacon::Welcome {
                v: PROTOCOL_VERSION,
                caps: vec!["ping"],
                agent: AGENT_ID,
            })
        }
        Request::Ping { n } => {
            *serving = true;
            write_reply(port, &Beacon::Pong { n })
        }
        Request::Shutdown => power_off(),
    }
}

/// Serve on one open port. Until the first decoded host frame arrives, keep
/// beaconing `announce` so the host can learn the port is live before it
/// risks writing into the UART. Polling interleaves beacon writes with reads.
fn serve_once(port: &mut File) {
    let mut serving = false;
    let mut last_beacon = std::time::Instant::now()
        - std::time::Duration::from_secs(1);
    loop {
        if !serving && last_beacon.elapsed() >= std::time::Duration::from_millis(500) {
            if !write_reply(port, &Beacon::Announce {
                v: PROTOCOL_VERSION,
                caps: vec!["ping"],
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
                if !write_reply(port, &Beacon::Error {
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
        if !handle_frame(port, request, &mut serving) {
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
        mount(c"proc", c"/proc", c"proc");
        mount(c"tmpfs", c"/tmp", c"tmpfs");
    }
    serve_forever()
}
