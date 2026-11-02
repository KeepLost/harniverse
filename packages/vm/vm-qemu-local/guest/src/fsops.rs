//! Filesystem operations: the eight-op semantic set (read, write, stat,
//! list, mkdir, unlink, rmdir, rename) with errno-carrying error replies.

use std::fs;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use base64::Engine as _;

use super::proto::{FsEntry, FsOp, FsStat, Reply, MAX_DATA_BYTES};

fn io_error(id: u64, error: &std::io::Error) -> Reply {
    Reply::FsErr { id, errno: error.raw_os_error().unwrap_or(0), message: error.to_string() }
}

fn invalid_path(id: u64) -> Reply {
    Reply::FsErr { id, errno: libc::EINVAL, message: "path must be absolute and NUL-free".to_string() }
}

fn ok(id: u64) -> Reply {
    Reply::FsOk { id, d: None, entries: None, st: None }
}

fn path_is_valid(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0')
}

/// Handle one fs request; every arm answers exactly one reply frame.
pub fn handle(sink: &crate::exec::Sink, id: u64, op: FsOp) {
    let reply = run(id, op);
    let payload = serde_json::to_vec(&reply).unwrap_or_default();
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    if let Ok(mut port) = sink.lock() {
        let _ = port.write_all(&frame);
    }
}

fn run(id: u64, op: FsOp) -> Reply {
    match op {
        FsOp::Read { path } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => return io_error(id, &error),
            };
            if metadata.is_dir() {
                return Reply::FsErr { id, errno: libc::EISDIR, message: "is a directory".to_string() }
            }
            if metadata.len() as usize > MAX_DATA_BYTES {
                return Reply::FsErr {
                    id,
                    errno: libc::EFBIG,
                    message: format!("file larger than {MAX_DATA_BYTES} bytes"),
                }
            }
            match fs::read(&path) {
                Ok(data) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
                    Reply::FsOk { id, d: Some(encoded), entries: None, st: None }
                }
                Err(error) => io_error(id, &error),
            }
        }
        FsOp::Write { path, d } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            let decoded = match base64::engine::general_purpose::STANDARD.decode(d) {
                Ok(decoded) if decoded.len() <= MAX_DATA_BYTES => decoded,
                Ok(_) => {
                    return Reply::FsErr {
                        id,
                        errno: libc::EFBIG,
                        message: format!("payload larger than {MAX_DATA_BYTES} bytes"),
                    }
                }
                Err(_) => {
                    return Reply::FsErr { id, errno: libc::EINVAL, message: "invalid base64 payload".to_string() }
                }
            };
            match fs::write(Path::new(&path), decoded) {
                Ok(()) => ok(id),
                Err(error) => io_error(id, &error),
            }
        }
        FsOp::Stat { path } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            match fs::metadata(&path) {
                Ok(metadata) => Reply::FsOk {
                    id,
                    d: None,
                    entries: None,
                    st: Some(FsStat {
                        kind: if metadata.is_dir() { "dir" } else { "file" },
                        size: metadata.len(),
                        mode: metadata.mode(),
                        mtime_ms: metadata.mtime() as f64 * 1000.0
                            + metadata.mtime_nsec() as f64 / 1_000_000.0,
                    }),
                },
                Err(error) => io_error(id, &error),
            }
        }
        FsOp::List { path } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            let directory = match fs::read_dir(&path) {
                Ok(directory) => directory,
                Err(error) => return io_error(id, &error),
            };
            let mut entries = Vec::new();
            for entry in directory {
                match entry {
                    Ok(entry) => {
                        let kind = entry.file_type().ok().and_then(|kind| {
                            if kind.is_dir() { Some("dir") } else { Some("file") }
                        });
                        let name = entry.file_name().to_string_lossy().into_owned();
                        entries.push(FsEntry { name, kind: kind.unwrap_or("file") });
                    }
                    Err(error) => return io_error(id, &error),
                }
            }
            Reply::FsOk { id, d: None, entries: Some(entries), st: None }
        }
        FsOp::Mkdir { path, recursive } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            let outcome = if recursive {
                fs::create_dir_all(&path)
            } else {
                fs::create_dir(&path)
            };
            match outcome {
                Ok(()) => ok(id),
                Err(error) => io_error(id, &error),
            }
        }
        FsOp::Unlink { path } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            match fs::remove_file(&path) {
                Ok(()) => ok(id),
                Err(error) => io_error(id, &error),
            }
        }
        FsOp::Rmdir { path } => {
            if !path_is_valid(&path) {
                return invalid_path(id)
            }
            match fs::remove_dir(&path) {
                Ok(()) => ok(id),
                Err(error) => io_error(id, &error),
            }
        }
        FsOp::Rename { from, to } => {
            if !path_is_valid(&from) || !path_is_valid(&to) {
                return invalid_path(id)
            }
            match fs::rename(&from, &to) {
                Ok(()) => ok(id),
                Err(error) => io_error(id, &error),
            }
        }
    }
}
