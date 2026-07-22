use crate::prelude::*;
use crate::*;

const PROJECTION_DELIVERY_SCHEMA_VERSION: &str = "deepcode.session.projection-delivery.v1";
const PROJECTION_DELIVERY_BATCH_SIZE: usize = 64;
const PROJECTION_DELIVERY_FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const PROJECTION_DELIVERY_MAX_RECORDS_PER_RUN: usize = 10_000;

#[derive(Default)]
pub(crate) struct ProjectionDeliveryBufferState {
    runs: HashMap<String, ProjectionDeliveryRunBuffer>,
}

#[derive(Default)]
struct ProjectionDeliveryRunBuffer {
    session_id: String,
    entries: Vec<Value>,
    accepted_count: usize,
    dropped_count: usize,
    flush_task: Option<tokio::task::JoinHandle<()>>,
}

pub(crate) fn record_daemon_projection_delivery(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    stage: &str,
    delta: Option<&Value>,
    result: &str,
    terminal: bool,
) {
    let entry = daemon_projection_delivery_entry(session_id, run_id, stage, delta, result);
    let (flush_now, arm_timer) = {
        let mut buffers = state
            .projection_delivery
            .lock()
            .expect("projection delivery buffer lock");
        let buffer = buffers.runs.entry(run_id.to_string()).or_default();
        buffer.session_id = session_id.to_string();
        if buffer.accepted_count >= PROJECTION_DELIVERY_MAX_RECORDS_PER_RUN {
            buffer.dropped_count += 1;
        } else {
            buffer.accepted_count += 1;
            buffer.entries.push(entry);
        }
        let flush_now = !terminal && buffer.entries.len() >= PROJECTION_DELIVERY_BATCH_SIZE;
        let arm_timer =
            !terminal && !flush_now && buffer.flush_task.is_none() && !buffer.entries.is_empty();
        (flush_now, arm_timer)
    };

    if flush_now {
        queue_projection_delivery_flush(state, run_id, false, true);
        return;
    }
    if arm_timer {
        let timer_state = state.clone();
        let timer_run_id = run_id.to_string();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(PROJECTION_DELIVERY_FLUSH_INTERVAL).await;
            queue_projection_delivery_flush(&timer_state, &timer_run_id, false, false);
        });
        let mut buffers = state
            .projection_delivery
            .lock()
            .expect("projection delivery buffer lock");
        if let Some(buffer) = buffers.runs.get_mut(run_id) {
            if buffer.flush_task.is_none() {
                buffer.flush_task = Some(handle);
            } else {
                handle.abort();
            }
        } else {
            handle.abort();
        }
    }
}

pub(crate) async fn flush_daemon_projection_delivery_terminal(state: &AppState, run_id: &str) {
    let Some((session_id, entries)) = take_projection_delivery_batch(state, run_id, true, true)
    else {
        return;
    };
    let flush_state = state.clone();
    let flush = tokio::task::spawn_blocking(move || {
        append_projection_delivery_entries(&flush_state, &session_id, entries)
    });
    match tokio::time::timeout(Duration::from_secs(2), flush).await {
        Ok(Ok(Ok(_))) => {}
        Ok(Ok(Err(error))) => eprintln!("projection delivery archive skipped: {error}"),
        Ok(Err(error)) => eprintln!("projection delivery flush task failed: {error}"),
        Err(_) => eprintln!("projection delivery terminal flush timed out after 2000ms"),
    }
}

fn queue_projection_delivery_flush(
    state: &AppState,
    run_id: &str,
    terminal: bool,
    cancel_timer: bool,
) {
    let Some((session_id, entries)) =
        take_projection_delivery_batch(state, run_id, terminal, cancel_timer)
    else {
        return;
    };
    let flush_state = state.clone();
    tokio::spawn(async move {
        match tokio::task::spawn_blocking(move || {
            append_projection_delivery_entries(&flush_state, &session_id, entries)
        })
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => eprintln!("projection delivery archive skipped: {error}"),
            Err(error) => eprintln!("projection delivery flush task failed: {error}"),
        }
    });
}

fn take_projection_delivery_batch(
    state: &AppState,
    run_id: &str,
    terminal: bool,
    cancel_timer: bool,
) -> Option<(String, Vec<Value>)> {
    let (session_id, entries) = {
        let mut buffers = state
            .projection_delivery
            .lock()
            .expect("projection delivery buffer lock");
        let Some(buffer) = buffers.runs.get_mut(run_id) else {
            return None;
        };
        if let Some(task) = buffer.flush_task.take() {
            if cancel_timer {
                task.abort();
            }
        }
        if terminal && buffer.dropped_count > 0 {
            buffer.entries.push(json!({
                "schemaVersion": PROJECTION_DELIVERY_SCHEMA_VERSION,
                "stage": "diagnostic.dropped",
                "at": now_millis().to_string(),
                "sessionId": buffer.session_id,
                "runId": run_id,
                "droppedCount": buffer.dropped_count,
                "result": "ignored"
            }));
            buffer.dropped_count = 0;
        }
        let result = (
            buffer.session_id.clone(),
            std::mem::take(&mut buffer.entries),
        );
        if terminal {
            buffers.runs.remove(run_id);
        }
        result
    };

    if entries.is_empty() {
        return None;
    }
    Some((session_id, entries))
}

fn daemon_projection_delivery_entry(
    session_id: &str,
    run_id: &str,
    stage: &str,
    delta: Option<&Value>,
    result: &str,
) -> Value {
    let mut entry = serde_json::Map::from_iter([
        (
            "schemaVersion".to_string(),
            Value::String(PROJECTION_DELIVERY_SCHEMA_VERSION.to_string()),
        ),
        ("stage".to_string(), Value::String(stage.to_string())),
        ("at".to_string(), Value::String(now_millis().to_string())),
        (
            "sessionId".to_string(),
            Value::String(session_id.to_string()),
        ),
        ("runId".to_string(), Value::String(run_id.to_string())),
        ("result".to_string(), Value::String(result.to_string())),
    ]);
    if let Some(delta) = delta {
        copy_string_field(delta, &mut entry, "turnId");
        copy_string_field(delta, &mut entry, "blockId");
        copy_string_field(delta, &mut entry, "op");
        copy_number_field(delta, &mut entry, "revision");
        copy_number_field(delta, &mut entry, "deltaSeq");
        let delivery_mode = delta
            .get("deliveryMode")
            .and_then(Value::as_str)
            .or_else(|| {
                delta
                    .get("block")
                    .and_then(|block| block.get("deliveryMode"))
                    .and_then(Value::as_str)
            });
        if let Some(delivery_mode) = delivery_mode {
            entry.insert(
                "deliveryMode".to_string(),
                Value::String(delivery_mode.to_string()),
            );
        }
        let content = projection_delta_content(delta);
        if !content.is_empty() {
            entry.insert(
                "charLength".to_string(),
                json!(content.encode_utf16().count()),
            );
            entry.insert(
                "contentHash".to_string(),
                Value::String(projection_delivery_content_hash(content)),
            );
        }
    }
    Value::Object(entry)
}

fn projection_delta_content(delta: &Value) -> &str {
    delta
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| {
            delta
                .get("block")
                .and_then(|block| block.get("bodyMarkdown"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            delta
                .get("block")
                .and_then(|block| block.get("summary"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
}

fn projection_delivery_content_hash(content: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for code_unit in content.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("fnv1a32:{hash:08x}")
}

fn copy_string_field(source: &Value, target: &mut serde_json::Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field).and_then(Value::as_str) {
        target.insert(field.to_string(), Value::String(value.to_string()));
    }
}

fn copy_number_field(source: &Value, target: &mut serde_json::Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field).and_then(Value::as_u64) {
        target.insert(field.to_string(), json!(value));
    }
}
