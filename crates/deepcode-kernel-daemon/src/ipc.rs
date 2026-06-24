use crate::prelude::*;
use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelCommandEnvelope {
    pub(crate) request_id: Option<String>,
    pub(crate) command: KernelCommand,
    pub(crate) idempotency_key: Option<String>,
    pub(crate) expected_snapshot_seq: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelReply {
    pub(crate) ok: bool,
    pub(crate) events: Vec<KernelEvent>,
    pub(crate) snapshot: Option<KernelSnapshot>,
    pub(crate) error: Option<KernelErrorEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelSnapshotQuery {
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelEventStreamQuery {
    pub(crate) session_id: Option<String>,
}

pub(crate) fn run_stdio_ipc(state: AppState) {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let reply = match line {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => match serde_json::from_str::<KernelCommandEnvelope>(&line) {
                Ok(body) => dispatch_kernel_command(&state, body),
                Err(error) => KernelReply {
                    ok: false,
                    events: Vec::new(),
                    snapshot: None,
                    error: Some(KernelErrorEnvelope {
                        code: "invalid_ipc_frame".to_string(),
                        message: format!("decode IPC frame failed: {error}"),
                        message_key: None,
                        args: None,
                    }),
                },
            },
            Err(error) => KernelReply {
                ok: false,
                events: Vec::new(),
                snapshot: None,
                error: Some(KernelErrorEnvelope {
                    code: "read_ipc_frame_failed".to_string(),
                    message: format!("read IPC frame failed: {error}"),
                    message_key: None,
                    args: None,
                }),
            },
        };
        let encoded = serde_json::to_string(&reply).unwrap_or_else(|error| {
            serde_json::json!({
                "ok": false,
                "events": [],
                "snapshot": null,
                "error": {
                    "code": "encode_ipc_reply_failed",
                    "message": format!("encode IPC reply failed: {error}")
                }
            })
            .to_string()
        });
        let _ = writeln!(stdout, "{encoded}");
        let _ = stdout.flush();
    }
}

pub(crate) fn run_length_prefixed_ipc(state: AppState) {
    const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    loop {
        let mut length_bytes = [0_u8; 4];
        match stdin.read_exact(&mut length_bytes) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                let _ = write_length_prefixed_reply(
                    &mut stdout,
                    &KernelReply {
                        ok: false,
                        events: Vec::new(),
                        snapshot: None,
                        error: Some(KernelErrorEnvelope {
                            code: "read_ipc_frame_failed".to_string(),
                            message: format!("read IPC frame length failed: {error}"),
                            message_key: None,
                            args: None,
                        }),
                    },
                );
                break;
            }
        }

        let length = u32::from_be_bytes(length_bytes) as usize;
        if length > MAX_FRAME_BYTES {
            let _ = write_length_prefixed_reply(
                &mut stdout,
                &KernelReply {
                    ok: false,
                    events: Vec::new(),
                    snapshot: None,
                    error: Some(KernelErrorEnvelope {
                        code: "ipc_frame_too_large".to_string(),
                        message: format!("IPC frame is {length} bytes; max is {MAX_FRAME_BYTES}"),
                        message_key: None,
                        args: None,
                    }),
                },
            );
            break;
        }

        let mut payload = vec![0_u8; length];
        let reply = match stdin.read_exact(&mut payload) {
            Ok(()) => match serde_json::from_slice::<KernelCommandEnvelope>(&payload) {
                Ok(body) => dispatch_kernel_command(&state, body),
                Err(error) => KernelReply {
                    ok: false,
                    events: Vec::new(),
                    snapshot: None,
                    error: Some(KernelErrorEnvelope {
                        code: "invalid_ipc_frame".to_string(),
                        message: format!("decode IPC frame failed: {error}"),
                        message_key: None,
                        args: None,
                    }),
                },
            },
            Err(error) => KernelReply {
                ok: false,
                events: Vec::new(),
                snapshot: None,
                error: Some(KernelErrorEnvelope {
                    code: "read_ipc_frame_failed".to_string(),
                    message: format!("read IPC frame payload failed: {error}"),
                    message_key: None,
                    args: None,
                }),
            },
        };
        if write_length_prefixed_reply(&mut stdout, &reply).is_err() {
            break;
        }
    }
}

pub(crate) fn write_length_prefixed_reply<W: Write>(
    writer: &mut W,
    reply: &KernelReply,
) -> io::Result<()> {
    let encoded = serde_json::to_vec(reply).map_err(io::Error::other)?;
    let length = u32::try_from(encoded.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "IPC reply too large"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(&encoded)?;
    writer.flush()
}

pub(crate) fn dispatch_kernel_command(
    state: &AppState,
    body: KernelCommandEnvelope,
) -> KernelReply {
    let session_id = kernel_command_session_id(&body.command);
    let _request_id = body.request_id.as_deref();
    let _idempotency_key = body.idempotency_key.as_deref();
    let _expected_snapshot_seq = body.expected_snapshot_seq;

    let result = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime.dispatch(body.command)
    };

    match result {
        Ok(events) => {
            record_kernel_events(state, &events);
            let snapshot = {
                let runtime = state.runtime.lock().expect("kernel runtime lock");
                runtime.snapshot(session_id.as_deref())
            };
            KernelReply {
                ok: true,
                events,
                snapshot: Some(snapshot),
                error: None,
            }
        }
        Err(error) => KernelReply {
            ok: false,
            events: Vec::new(),
            snapshot: None,
            error: Some(KernelErrorEnvelope::from(&error)),
        },
    }
}
