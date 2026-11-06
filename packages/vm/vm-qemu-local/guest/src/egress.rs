//! Guest egress surface: one SOCKS5 loopback listener per origin-tagged
//! exec. The world has no network device, so a process reaches the internet
//! only through this listener: each CONNECT asks the host (`egress.open`
//! carrying the exec's origin token), and only an `egress.opened` answer
//! lets bytes flow — relayed as base64 `egress.write` frames outbound and
//! `egress.data` frames inbound until `egress.end` (orderly EOF) or
//! `egress.close` (teardown) settles the stream. A denied or unattributed
//! dial answers the SOCKS client with a general failure.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::{Arc, Condvar, Mutex};

use base64::Engine as _;

use super::exec::{Sink, reply};
use super::proto::{self, Reply};

/// Chunk size the client pump reads per `egress.write` frame; base64
/// inflates it by 4/3, staying well under the frame ceiling.
const STREAM_CHUNK: usize = 32 * 1024;

/// How long the approval wait sleeps between client-liveness probes.
const APPROVAL_POLL_MS: u64 = 500;

/// SOCKS5 success reply (IPv4 0.0.0.0:0 bound-address placeholder).
const SOCKS_OK: [u8; 10] = [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
/// SOCKS5 general failure reply.
const SOCKS_FAIL: [u8; 10] = [0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0];

enum Phase {
    /// Waiting for the host's `egress.opened` / `egress.denied`.
    Pending,
    Open,
    Denied,
}

/// One outbound unit the stream's writer thread consumes.
enum Outbound {
    /// Remote bytes to hand the guest client.
    Data(Vec<u8>),
    /// Remote EOF: stop writing, the client then reads EOF.
    End,
}

struct StreamState {
    /// Clone kept only for liveness probing; writes own the writer thread.
    probe: Mutex<TcpStream>,
    /// Writer-thread inbox; `None` once the stream tore down.
    sender: Mutex<Option<std::sync::mpsc::Sender<Outbound>>>,
    phase: Mutex<Phase>,
    settled: Condvar,
}

/// Live egress streams keyed by guest-assigned id; shared between the main
/// control loop (host events) and the per-connection threads.
#[derive(Default)]
pub struct Manager {
    next_id: Mutex<u64>,
    streams: Mutex<HashMap<u64, Arc<StreamState>>>,
}

fn read_exact(stream: &mut TcpStream, buffer: &mut [u8]) -> bool {
    stream.read_exact(buffer).is_ok()
}

/// The minimal SOCKS5 handshake this listener serves: no auth, CONNECT
/// only. Returns the requested host and port, or `None` to drop the client.
fn socks5_handshake(stream: &mut TcpStream) -> Option<(String, u16)> {
    let mut header = [0u8; 2];
    if !read_exact(stream, &mut header) || header[0] != 0x05 || header[1] == 0 {
        return None;
    }
    let mut methods = vec![0u8; header[1] as usize];
    if !read_exact(stream, &mut methods) {
        return None;
    }
    if stream.write_all(&[0x05, 0x00]).is_err() {
        return None;
    }
    let mut request = [0u8; 4];
    if !read_exact(stream, &mut request) || request[0] != 0x05 || request[1] != 0x01 {
        return None;
    }
    let host = match request[3] {
        0x01 => {
            let mut octets = [0u8; 4];
            if !read_exact(stream, &mut octets) {
                return None;
            }
            octets.iter().map(|byte| byte.to_string()).collect::<Vec<_>>().join(".")
        }
        0x03 => {
            let mut length = [0u8; 1];
            if !read_exact(stream, &mut length) {
                return None;
            }
            let mut name = vec![0u8; length[0] as usize];
            if !read_exact(stream, &mut name) {
                return None;
            }
            String::from_utf8(name).ok()?
        }
        0x04 => {
            let mut octets = [0u8; 16];
            if !read_exact(stream, &mut octets) {
                return None;
            }
            let mut groups = Vec::new();
            for pair in octets.chunks(2) {
                groups.push(format!("{:02x}{:02x}", pair[0], pair[1]));
            }
            groups.join(":")
        }
        _ => return None,
    };
    if host.is_empty() || host.contains('\0') {
        return None;
    }
    let mut port_bytes = [0u8; 2];
    if !read_exact(stream, &mut port_bytes) {
        return None;
    }
    Some((host, u16::from_be_bytes(port_bytes)))
}

/// Non-consuming liveness probe: `true` when the client already hung up.
fn client_gone(socket: &TcpStream) -> bool {
    let mut probe = [0u8; 1];
    // SAFETY: recv(2) with MSG_PEEK|MSG_DONTWAIT on our own fd; the byte
    // stays in the socket buffer for the pump thread to read.
    let seen = unsafe {
        libc::recv(socket.as_raw_fd(), probe.as_mut_ptr() as *mut libc::c_void, 1, libc::MSG_PEEK | libc::MSG_DONTWAIT)
    };
    seen == 0
}

/// Wait for the host's verdict, probing the client between sleeps so a
/// hung-up client ends its wait even while a human reads an approval card.
fn await_verdict(state: &Arc<StreamState>) -> bool {
    loop {
        {
            let phase = state.phase.lock().unwrap();
            match &*phase {
                Phase::Open => return true,
                Phase::Denied => return false,
                Phase::Pending => {}
            }
            let (guard, _) = state.settled.wait_timeout(phase, std::time::Duration::from_millis(APPROVAL_POLL_MS)).unwrap();
            match &*guard {
                Phase::Open => return true,
                Phase::Denied => return false,
                Phase::Pending => {}
            }
        }
        if let Ok(socket) = state.probe.try_lock() {
            if client_gone(&socket) {
                return false;
            }
        }
    }
}

fn remove_stream(manager: &Manager, id: u64) {
    manager.streams.lock().unwrap().remove(&id);
}

/// Serve one accepted client: handshake, ask the host, then pump the
/// client's bytes as `egress.write` frames until EOF or error.
fn serve_client(mut client: TcpStream, manager: Arc<Manager>, sink: Sink, origin: String) {
    let Some((host, port)) = socks5_handshake(&mut client) else {
        return;
    };
    let id = {
        let mut next = manager.next_id.lock().unwrap();
        *next += 1;
        *next
    };
    // Writes never touch the control loop: a slow client would otherwise
    // block the main thread's frame dispatch head-of-line. The writer
    // thread owns its socket clone and drains an unbounded inbox; a truly
    // stalled client grows guest memory until its exec budget kills it.
    let (sender, receiver) = std::sync::mpsc::channel::<Outbound>();
    let mut writer_socket = client.try_clone().expect("tcp stream clone");
    let probe_socket = client.try_clone().expect("tcp stream clone");
    std::thread::spawn(move || {
        for outbound in receiver {
            match outbound {
                Outbound::Data(bytes) => {
                    if writer_socket.write_all(&bytes).is_err() {
                        return;
                    }
                }
                Outbound::End => {
                    let _ = writer_socket.shutdown(std::net::Shutdown::Write);
                }
            }
        }
    });
    let state = Arc::new(StreamState {
        probe: Mutex::new(probe_socket),
        sender: Mutex::new(Some(sender)),
        phase: Mutex::new(Phase::Pending),
        settled: Condvar::new(),
    });
    manager.streams.lock().unwrap().insert(id, Arc::clone(&state));
    reply(&sink, &Reply::EgressOpen { id, host: host.clone(), port, origin: Some(origin) });

    if !await_verdict(&state) {
        remove_stream(&manager, id);
        let _ = client.write_all(&SOCKS_FAIL);
        return;
    }
    if client.write_all(&SOCKS_OK).is_err() {
        remove_stream(&manager, id);
        reply(&sink, &Reply::EgressClose { id });
        return;
    }

    let mut buffer = vec![0u8; STREAM_CHUNK];
    loop {
        match client.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer[..n]);
                reply(&sink, &Reply::EgressWrite { id, d: encoded });
            }
            Err(_) => break,
        }
    }
    remove_stream(&manager, id);
    reply(&sink, &Reply::EgressClose { id });
}

/// Bind the loopback SOCKS5 listener for one origin and hand back its port;
/// the exec injects it into the child's environment as `ALL_PROXY`.
pub fn prepare(origin: &str, manager: &Arc<Manager>, sink: &Sink) -> Option<u16> {
    if origin.is_empty() || origin.contains('\0') {
        return None;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    let manager = Arc::clone(manager);
    let sink = Arc::clone(sink);
    let origin = origin.to_string();
    std::thread::spawn(move || {
        for client in listener.incoming() {
            let Ok(client) = client else { return };
            let manager = Arc::clone(&manager);
            let sink = Arc::clone(&sink);
            let origin = origin.clone();
            std::thread::spawn(move || serve_client(client, manager, sink, origin));
        }
    });
    Some(port)
}

/// Environment entries advertising the per-exec SOCKS5 proxy.
pub fn proxy_env(port: u16) -> Vec<(&'static str, String)> {
    let endpoint = format!("socks5h://127.0.0.1:{port}");
    vec![("ALL_PROXY", endpoint.clone()), ("all_proxy", endpoint)]
}

/// Host approved the stream; wake the waiting client thread.
pub fn on_opened(manager: &Manager, id: u64) {
    if let Some(state) = manager.streams.lock().unwrap().get(&id) {
        let mut phase = state.phase.lock().unwrap();
        if matches!(&*phase, Phase::Pending) {
            *phase = Phase::Open;
            state.settled.notify_all();
        }
    }
}

/// Host refused the stream; wake the waiting client thread.
pub fn on_denied(manager: &Manager, id: u64) {
    if let Some(state) = manager.streams.lock().unwrap().get(&id) {
        let mut phase = state.phase.lock().unwrap();
        if matches!(&*phase, Phase::Pending) {
            *phase = Phase::Denied;
            state.settled.notify_all();
        }
    }
}

/// Inbound remote bytes: decode and queue for the stream's writer thread.
pub fn on_data(manager: &Manager, id: u64, encoded: &str) {
    let decoded = match base64::engine::general_purpose::STANDARD.decode(encoded) {
        Ok(decoded) if decoded.len() <= proto::MAX_DATA_BYTES => decoded,
        _ => return,
    };
    if let Some(state) = manager.streams.lock().unwrap().get(&id) {
        if let Ok(sender) = state.sender.lock() {
            match sender.as_ref() {
                Some(sender) => {
                    if sender.send(Outbound::Data(decoded)).is_err() {
                        drop(sender);
                        remove_stream(manager, id);
                    }
                }
                None => remove_stream(manager, id),
            }
        }
    }
}

/// Remote EOF: the guest client reads EOF once the writer shuts its side.
pub fn on_end(manager: &Manager, id: u64) {
    if let Some(state) = manager.streams.lock().unwrap().get(&id) {
        if let Ok(sender) = state.sender.lock() {
            if let Some(sender) = sender.as_ref() {
                let _ = sender.send(Outbound::End);
            }
        }
    }
}

/// Host-side teardown: dropping the state closes the client socket.
pub fn on_close(manager: &Manager, id: u64) {
    remove_stream(manager, id);
}
