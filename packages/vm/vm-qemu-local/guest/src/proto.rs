//! Wire protocol types for the guest agent: the request enum the host may
//! send and the reply enum this agent emits, both tagged with `t` on the wire.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u64 = 3;
pub const AGENT_ID: &str = concat!("dsh-vm-guest-agent ", env!("CARGO_PKG_VERSION"));
pub const CONTROL_PORT: &str = "/dev/ttyS1";
pub const MAX_FRAME_BYTES: u32 = 1 << 20;
/// Largest decoded byte payload one stream chunk or fs transfer carries; the
/// base64 form stays safely under {@link MAX_FRAME_BYTES}.
pub const MAX_DATA_BYTES: usize = 512 * 1024;
pub const CAPS: &[&str] = &["ping", "exec", "fs", "workspace"];

#[derive(Serialize)]
#[serde(tag = "t")]
pub enum Reply {
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
    #[serde(rename = "exec.started")]
    ExecStarted { id: u64, pid: u32 },
    #[serde(rename = "exec.out")]
    ExecOut { id: u64, s: &'static str, d: String },
    #[serde(rename = "exec.exit")]
    ExecExit { id: u64, code: i32, sig: Option<&'static str> },
    #[serde(rename = "exec.acked")]
    ExecAcked { id: u64 },
    #[serde(rename = "exec.err")]
    ExecErr { id: u64, message: String },
    #[serde(rename = "fs.ok")]
    FsOk {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        d: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        entries: Option<Vec<FsEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        st: Option<FsStat>,
    },
    #[serde(rename = "fs.err")]
    FsErr { id: u64, errno: i32, message: String },
    #[serde(rename = "workspace.ok")]
    WorkspaceOk { id: u64, bytes: u64 },
    #[serde(rename = "workspace.err")]
    WorkspaceErr { id: u64, message: String },
}

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub kind: &'static str,
}

#[derive(Serialize)]
pub struct FsStat {
    pub kind: &'static str,
    pub size: u64,
    pub mode: u32,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
}

#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum Request {
    #[serde(rename = "hello")]
    Hello { v: u64 },
    #[serde(rename = "ping")]
    Ping { n: u64 },
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "exec")]
    Exec {
        id: u64,
        argv: Vec<String>,
        #[serde(default)]
        env: Option<HashMap<String, String>>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        pty: Option<PtySize>,
    },
    #[serde(rename = "exec.stdin")]
    ExecStdin { id: u64, d: String },
    #[serde(rename = "exec.stdin.close")]
    ExecStdinClose { id: u64 },
    #[serde(rename = "exec.signal")]
    ExecSignal { id: u64, sig: String },
    #[serde(rename = "fs")]
    Fs {
        id: u64,
        #[serde(flatten)]
        op: FsOp,
    },
    #[serde(rename = "workspace.import")]
    WorkspaceImport { id: u64 },
    #[serde(rename = "workspace.export")]
    WorkspaceExport { id: u64 },
}

#[derive(Deserialize)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}

/// Which workspace data-plane transfer a request starts.
#[derive(Clone, Copy)]
pub enum DataOp {
    Import,
    Export,
}

#[derive(Deserialize)]
#[serde(tag = "op")]
pub enum FsOp {
    #[serde(rename = "read")]
    Read { path: String },
    #[serde(rename = "write")]
    Write { path: String, d: String },
    #[serde(rename = "stat")]
    Stat { path: String },
    #[serde(rename = "list")]
    List { path: String },
    #[serde(rename = "mkdir")]
    Mkdir { path: String, #[serde(default)] recursive: bool },
    #[serde(rename = "unlink")]
    Unlink { path: String },
    #[serde(rename = "rmdir")]
    Rmdir { path: String },
    #[serde(rename = "rename")]
    Rename { from: String, to: String },
}
