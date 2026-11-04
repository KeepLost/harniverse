//! Workspace data-plane operations: unpack the import image (/dev/vda,
//! read-only) into `/workspace` and pack the directory into the export
//! image (/dev/vdb), streaming through busybox tar so payloads never
//! double-buffer in guest RAM. One transfer runs at a time; the images are
//! single-owner devices and a second request answers `busy`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::FileExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use super::exec::Sink;
use super::proto::{DataOp, Reply};

/// Shared on-disk layout with the host: magic plus payload length, then tar.
const MAGIC: &[u8; 8] = b"DSHWSI01";
/// Payload offset inside both images.
const HEADER_BYTES: u64 = 4096;
/// Read-only import device attached by the host when a workspace is staged.
const IMPORT_DEVICE: &str = "/dev/vda";
/// Writable export device attached by the host when a workspace is staged.
const EXPORT_DEVICE: &str = "/dev/vdb";
/// The world's workspace directory.
const WORKSPACE: &str = "/workspace";
/// Stream chunk between device and tar pipe.
const CHUNK: usize = 64 * 1024;
/// Sanity ceiling matching the host's default image capacity.
const MAX_PAYLOAD: u64 = 1 << 30;

/// One transfer at a time; the images are single-owner devices.
static BUSY: AtomicBool = AtomicBool::new(false);

fn reply(sink: &Sink, message: &Reply) {
    let payload = serde_json::to_vec(message).unwrap_or_default();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    if let Ok(mut port) = sink.lock() {
        let _ = port.write_all(&frame);
    }
}

/// Handle one workspace request; busy answers inline, real work runs in a
/// thread that clears the latch when the transfer settles.
pub fn handle(sink: &Sink, id: u64, op: DataOp) {
    if BUSY.swap(true, Ordering::SeqCst) {
        reply(sink, &Reply::WorkspaceErr { id, message: "busy".to_string() });
        return
    }
    let sink = std::sync::Arc::clone(sink);
    thread::spawn(move || {
        let outcome = match op {
            DataOp::Import => run_import(),
            DataOp::Export => run_export(),
        };
        match outcome {
            Ok(bytes) => reply(&sink, &Reply::WorkspaceOk { id, bytes }),
            Err(message) => reply(&sink, &Reply::WorkspaceErr { id, message }),
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

/// Read the payload length after validating the image header.
fn payload_length(device: &File) -> Result<u64, String> {
    let mut header = [0u8; 16];
    device
        .read_exact_at(&mut header, 0)
        .map_err(|error| format!("read image header: {error}"))?;
    if &header[0..8] != MAGIC {
        return Err("workspace image magic mismatch".to_string())
    }
    let length = u64::from_be_bytes(header[8..16].try_into().expect("slice is 8 bytes"));
    if length > MAX_PAYLOAD {
        return Err(format!("workspace payload {length} exceeds the {MAX_PAYLOAD}-byte ceiling"))
    }
    Ok(length)
}

fn write_header(device: &File, length: u64) -> Result<(), String> {
    let mut header = [0u8; 16];
    header[0..8].copy_from_slice(MAGIC);
    header[8..16].copy_from_slice(&length.to_be_bytes());
    device
        .write_all_at(&header, 0)
        .map_err(|error| format!("write image header: {error}"))
}

fn spawn_tar(args: &[&str]) -> Result<Child, String> {
    Command::new("/bin/tar")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("spawn tar: {error}"))
}

fn wait_tar(mut child: Child, what: &str) -> Result<(), String> {
    let status = child.wait().map_err(|error| format!("wait tar: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("tar {what} exited with {status}"))
    }
}

/// Import: replace `/workspace` with the import image's tar payload.
fn run_import() -> Result<u64, String> {
    let device = File::open(IMPORT_DEVICE).map_err(|error| format!("open {IMPORT_DEVICE}: {error}"))?;
    let length = payload_length(&device)?;
    match fs::remove_dir_all(WORKSPACE) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("clear workspace: {error}")),
    }
    fs::create_dir_all(WORKSPACE).map_err(|error| format!("create workspace: {error}"))?;
    let mut child = spawn_tar(&["xf", "-", "-C", WORKSPACE])?;
    let mut stdin: ChildStdin = child.stdin.take().ok_or_else(|| "tar stdin missing".to_string())?;
    let mut done: u64 = 0;
    let mut buffer = vec![0u8; CHUNK];
    let mut error: Option<String> = None;
    while done < length {
        let want = ((length - done) as usize).min(CHUNK);
        if let Err(e) = device.read_exact_at(&mut buffer[..want], HEADER_BYTES + done) {
            error = Some(format!("read import payload: {e}"));
            break
        }
        if let Err(e) = stdin.write_all(&buffer[..want]) {
            error = Some(format!("feed tar: {e}"));
            break
        }
        done += want as u64;
    }
    drop(stdin);
    wait_tar(child, "unpack")?;
    match error {
        Some(message) => Err(message),
        None => Ok(length),
    }
}

/// Export: pack `/workspace` into the export image, header last.
fn run_export() -> Result<u64, String> {
    let device = OpenOptions::new()
        .read(true)
        .write(true)
        .open(EXPORT_DEVICE)
        .map_err(|error| format!("open {EXPORT_DEVICE}: {error}"))?;
    let mut child = spawn_tar(&["cf", "-", "-C", WORKSPACE, "."])?;
    let mut stdout: ChildStdout = child.stdout.take().ok_or_else(|| "tar stdout missing".to_string())?;
    let mut offset = HEADER_BYTES;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = stdout
            .read(&mut buffer)
            .map_err(|error| format!("drain tar: {error}"))?;
        if read == 0 {
            break
        }
        device
            .write_all_at(&buffer[..read], offset)
            .map_err(|error| format!("write export payload: {error}"))?;
        offset += read as u64;
    }
    let length = offset - HEADER_BYTES;
    wait_tar(child, "pack")?;
    write_header(&device, length)?;
    device.sync_all().map_err(|error| format!("flush export image: {error}"))?;
    Ok(length)
}
