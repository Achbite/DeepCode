use crate::host_v2_storage::{sha256_prefixed, stable_json_sha256};
use crate::prelude::*;
use crate::*;
use bytes::Bytes;

pub(crate) const PROVIDER_TRACE_CAPABILITY_HEADER_V1: &str = "x-deepcode-provider-trace-capability";
pub(crate) const PROVIDER_TRACE_DIGEST_HEADER_V1: &str = "x-deepcode-provider-trace-digest";
const EMPTY_DIGEST_V1: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const PROVIDER_TRACE_TASK_FAILED_V1: &str = "provider_trace_task_failed";
const PROVIDER_TRACE_EXPORT_CHUNK_BYTES_V1: usize = 64 * 1024;
const PROVIDER_TRACE_EXPORT_DELIVERED_V1: &str = "succeeded_body_producer_fully_delivered";
const PROVIDER_TRACE_EXPORT_RECEIVER_CLOSED_V1: &str = "body_receiver_closed";
const PROVIDER_TRACE_EXPORT_HANDLER_CANCELLED_V1: &str = "handler_cancelled_before_response";
const PROVIDER_TRACE_EXPORT_READ_FAILED_V1: &str = "archive_read_failed";
const PROVIDER_TRACE_EXPORT_READER_TASK_FAILED_V1: &str = "body_producer_task_failed";
const PROVIDER_TRACE_EXPORT_DAEMON_LIMIT_V1: usize = 8;

#[derive(Clone, Default)]
pub(crate) struct ProviderTraceExportLimiterV1 {
    inner: Arc<std::sync::Mutex<ProviderTraceExportActivityV1>>,
}

#[derive(Default)]
struct ProviderTraceExportActivityV1 {
    active_total: usize,
    active_sessions: std::collections::HashSet<String>,
}

pub(crate) struct ProviderTraceExportPermitV1 {
    limiter: ProviderTraceExportLimiterV1,
    session_id: String,
}

impl ProviderTraceExportLimiterV1 {
    pub(crate) fn acquire(
        &self,
        session_id: &str,
    ) -> Result<ProviderTraceExportPermitV1, (&'static str, &'static str)> {
        let mut activity = self.inner.lock().map_err(|_| {
            (
                "provider_trace_export_limiter_unavailable",
                "Provider trace export concurrency state is unavailable",
            )
        })?;
        if activity.active_sessions.contains(session_id) {
            return Err((
                "provider_trace_export_session_busy",
                "This Session already has an active Provider trace export",
            ));
        }
        if activity.active_total >= PROVIDER_TRACE_EXPORT_DAEMON_LIMIT_V1 {
            return Err((
                "provider_trace_export_capacity_exceeded",
                "Provider trace export reached the daemon-wide concurrency limit",
            ));
        }
        activity.active_total += 1;
        activity.active_sessions.insert(session_id.to_string());
        Ok(ProviderTraceExportPermitV1 {
            limiter: self.clone(),
            session_id: session_id.to_string(),
        })
    }
}

impl Drop for ProviderTraceExportPermitV1 {
    fn drop(&mut self) {
        let mut activity = match self.limiter.inner.lock() {
            Ok(activity) => activity,
            Err(poisoned) => poisoned.into_inner(),
        };
        if activity.active_sessions.remove(&self.session_id) {
            activity.active_total = activity.active_total.saturating_sub(1);
        }
    }
}

#[derive(Clone)]
struct ProviderTraceExportAuditContextV1 {
    store: ProviderTraceStoreV1,
    session_id: String,
    run_id: String,
    provider_turn_id: String,
    request_id: String,
    payload_digest: String,
    trace_digest: String,
}

#[derive(Clone, Debug)]
enum ProviderTraceExportProducerStateV1 {
    Active,
    ReadyForDelivery,
    DeadlineExceeded,
    ReadFailed(String),
    ReaderTaskFailed,
}

enum ProviderTraceExportValidationDeliveryV1 {
    Authorized {
        export: ProviderTraceAuthorizedExportV1,
        io_guard: tokio::sync::OwnedRwLockReadGuard<()>,
        export_permit: ProviderTraceExportPermitV1,
        acknowledgment: tokio::sync::oneshot::Sender<ProviderTraceExportValidationAckV1>,
    },
    Rejected(ProviderTraceErrorV1),
    TaskFailed,
}

enum ProviderTraceExportValidationAckV1 {
    BodyOwned,
    DeadlineExceeded {
        completion: tokio::sync::oneshot::Sender<Result<(), ProviderTraceErrorV1>>,
    },
}

async fn record_provider_trace_export_outcome(
    action: &'static str,
    context: ProviderTraceExportAuditContextV1,
    result_code: &'static str,
) -> Result<(), ProviderTraceErrorV1> {
    tokio::task::spawn_blocking(move || {
        context.store.record_export_outcome(
            action,
            &context.session_id,
            &context.run_id,
            &context.provider_turn_id,
            &context.request_id,
            &context.payload_digest,
            &context.trace_digest,
            result_code,
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(ProviderTraceErrorV1 {
            code: "provider_trace_audit_write_failed",
            message: "Provider trace export audit task failed".to_string(),
        })
    })
}

pub(crate) async fn provider_trace_metadata_list(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Response {
    let io_guard = match provider_trace_session_guard(&state, &session_id).await {
        Ok(guard) => guard,
        Err((code, message)) => return provider_trace_error_response(code, message),
    };
    let store = state.provider_trace_v1.clone();
    let read_session_id = session_id.clone();
    let response = match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.list_verified_metadata(&read_session_id)
    })
    .await
    {
        Ok(Ok(traces)) => ApiResponse::ok(json!({
            "schemaVersion": "deepcode.provider-trace-metadata-list.v1",
            "sessionId": session_id,
            "traces": traces,
        })),
        Ok(Err(error)) => ApiResponse::error(error.code, error.message),
        Err(_) => {
            return provider_trace_error_response(
                PROVIDER_TRACE_TASK_FAILED_V1,
                "Provider trace metadata task failed",
            )
        }
    };
    provider_trace_api_response(response)
}

pub(crate) async fn provider_trace_export_capability_mint(
    State(state): State<AppState>,
    Path((session_id, provider_turn_id)): Path<(String, String)>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let io_guard = match provider_trace_session_guard(&state, &session_id).await {
        Ok(guard) => guard,
        Err((code, message)) => {
            let payload_digest = malformed_provider_trace_payload_digest(
                "mint",
                &session_id,
                &provider_turn_id,
                code,
            );
            if let Err(response) = record_provider_trace_failure(
                &state,
                "mint",
                &session_id,
                "",
                &provider_turn_id,
                "",
                &payload_digest,
                EMPTY_DIGEST_V1,
                code,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(code, message);
        }
    };
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            let code = "provider_trace_capability_body_invalid";
            let payload_digest = malformed_provider_trace_payload_digest(
                "mint",
                &session_id,
                &provider_turn_id,
                code,
            );
            if let Err(response) = record_provider_trace_failure(
                &state,
                "mint",
                &session_id,
                "",
                &provider_turn_id,
                "",
                &payload_digest,
                EMPTY_DIGEST_V1,
                code,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(
                code,
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    "Provider trace capability request exceeded the body limit."
                } else {
                    "Provider trace capability request body is invalid JSON."
                },
            );
        }
    };
    let run_id = body
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let trace_digest = body
        .get("traceDigest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let attempted_payload_digest = provider_trace_request_payload_digest(
        &session_id,
        &run_id,
        &provider_turn_id,
        &trace_digest,
        &request_id,
    );
    let store = state.provider_trace_v1.clone();
    let mint_session_id = session_id.clone();
    let mint_run_id = run_id.clone();
    let mint_provider_turn_id = provider_turn_id.clone();
    let mint_trace_digest = trace_digest.clone();
    let mint_request_id = request_id.clone();
    let mint_result = tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.mint_export_capability(
            &mint_session_id,
            &mint_run_id,
            &mint_provider_turn_id,
            &mint_trace_digest,
            &mint_request_id,
        )
    })
    .await;
    let response = match mint_result {
        Ok(Ok(capability)) => ApiResponse::ok(json!(capability)),
        Ok(Err(error)) => {
            if let Err(response) = record_provider_trace_failure(
                &state,
                "mint",
                &session_id,
                &run_id,
                &provider_turn_id,
                &request_id,
                &attempted_payload_digest,
                &trace_digest,
                error.code,
            )
            .await
            {
                return response;
            }
            ApiResponse::error(error.code, error.message)
        }
        Err(_) => {
            if let Err(response) = record_provider_trace_failure(
                &state,
                "mint",
                &session_id,
                &run_id,
                &provider_turn_id,
                &request_id,
                &attempted_payload_digest,
                &trace_digest,
                PROVIDER_TRACE_TASK_FAILED_V1,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(
                PROVIDER_TRACE_TASK_FAILED_V1,
                "Provider trace capability task failed",
            );
        }
    };
    provider_trace_api_response(response)
}

pub(crate) async fn provider_trace_export(
    State(state): State<AppState>,
    Path((session_id, provider_turn_id)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let io_guard = match provider_trace_session_guard(&state, &session_id).await {
        Ok(guard) => guard,
        Err((code, message)) => {
            let payload_digest = malformed_provider_trace_payload_digest(
                "export",
                &session_id,
                &provider_turn_id,
                code,
            );
            if let Err(response) = record_provider_trace_failure(
                &state,
                "export",
                &session_id,
                "",
                &provider_turn_id,
                "",
                &payload_digest,
                EMPTY_DIGEST_V1,
                code,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(code, message);
        }
    };
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            let code = "provider_trace_export_body_invalid";
            let payload_digest = malformed_provider_trace_payload_digest(
                "export",
                &session_id,
                &provider_turn_id,
                code,
            );
            if let Err(response) = record_provider_trace_failure(
                &state,
                "export",
                &session_id,
                "",
                &provider_turn_id,
                "",
                &payload_digest,
                EMPTY_DIGEST_V1,
                code,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(
                code,
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    "Provider trace export request exceeded the body limit."
                } else {
                    "Provider trace export request body is invalid JSON."
                },
            );
        }
    };
    let run_id = body
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let trace_digest = body
        .get("traceDigest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let payload_digest = body
        .get("payloadDigest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let capability = headers
        .get(PROVIDER_TRACE_CAPABILITY_HEADER_V1)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let export_permit = match state.provider_trace_export_limiter_v1.acquire(&session_id) {
        Ok(permit) => permit,
        Err((code, message)) => {
            drop(io_guard);
            if let Err(response) = record_provider_trace_failure(
                &state,
                "export",
                &session_id,
                &run_id,
                &provider_turn_id,
                &request_id,
                &payload_digest,
                &trace_digest,
                code,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(code, message);
        }
    };
    let store = state.provider_trace_v1.clone();
    let export_session_id = session_id.clone();
    let export_run_id = run_id.clone();
    let export_provider_turn_id = provider_turn_id.clone();
    let export_trace_digest = trace_digest.clone();
    let export_request_id = request_id.clone();
    let export_payload_digest = payload_digest.clone();
    let validation_audit_context = ProviderTraceExportAuditContextV1 {
        store: state.provider_trace_v1.clone(),
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        provider_turn_id: provider_turn_id.clone(),
        request_id: request_id.clone(),
        payload_digest: payload_digest.clone(),
        trace_digest: trace_digest.clone(),
    };
    let (validation_sender, validation_receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let validation_result = tokio::task::spawn_blocking(move || {
            let result = store.export_with_capability(
                &capability,
                &export_session_id,
                &export_run_id,
                &export_provider_turn_id,
                &export_trace_digest,
                &export_request_id,
                &export_payload_digest,
            );
            (result, io_guard, export_permit)
        })
        .await;
        match validation_result {
            Ok((Ok(export), io_guard, export_permit)) => {
                let (acknowledgment, acknowledged) = tokio::sync::oneshot::channel();
                let delivery = ProviderTraceExportValidationDeliveryV1::Authorized {
                    export,
                    io_guard,
                    export_permit,
                    acknowledgment,
                };
                if let Err(undelivered) = validation_sender.send(delivery) {
                    drop(undelivered);
                    let _ = record_provider_trace_export_outcome(
                        "validate",
                        validation_audit_context,
                        PROVIDER_TRACE_EXPORT_HANDLER_CANCELLED_V1,
                    )
                    .await;
                    return;
                }
                match acknowledged.await {
                    Ok(ProviderTraceExportValidationAckV1::BodyOwned) => {}
                    Ok(ProviderTraceExportValidationAckV1::DeadlineExceeded { completion }) => {
                        let result = record_provider_trace_export_outcome(
                            "validate",
                            validation_audit_context,
                            PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1,
                        )
                        .await;
                        let _ = completion.send(result);
                    }
                    Err(_) => {
                        let _ = record_provider_trace_export_outcome(
                            "validate",
                            validation_audit_context,
                            PROVIDER_TRACE_EXPORT_HANDLER_CANCELLED_V1,
                        )
                        .await;
                    }
                }
            }
            Ok((Err(error), io_guard, export_permit)) => {
                drop(io_guard);
                drop(export_permit);
                let result_code = error.code;
                let delivery = match record_provider_trace_export_outcome(
                    "validate",
                    validation_audit_context,
                    result_code,
                )
                .await
                {
                    Ok(()) => ProviderTraceExportValidationDeliveryV1::Rejected(error),
                    Err(audit_error) => {
                        ProviderTraceExportValidationDeliveryV1::Rejected(audit_error)
                    }
                };
                let _ = validation_sender.send(delivery);
            }
            Err(_) => {
                let delivery = match record_provider_trace_export_outcome(
                    "validate",
                    validation_audit_context,
                    PROVIDER_TRACE_TASK_FAILED_V1,
                )
                .await
                {
                    Ok(()) => ProviderTraceExportValidationDeliveryV1::TaskFailed,
                    Err(error) => ProviderTraceExportValidationDeliveryV1::Rejected(error),
                };
                let _ = validation_sender.send(delivery);
            }
        }
    });
    let validation_delivery = match validation_receiver.await {
        Ok(delivery) => delivery,
        Err(_) => {
            if let Err(response) = record_provider_trace_failure(
                &state,
                "validate",
                &session_id,
                &run_id,
                &provider_turn_id,
                &request_id,
                &payload_digest,
                &trace_digest,
                PROVIDER_TRACE_TASK_FAILED_V1,
            )
            .await
            {
                return response;
            }
            return provider_trace_error_response(
                PROVIDER_TRACE_TASK_FAILED_V1,
                "Provider trace validation supervisor failed",
            );
        }
    };
    match validation_delivery {
        ProviderTraceExportValidationDeliveryV1::Authorized {
            export,
            io_guard,
            export_permit,
            acknowledgment,
        } => {
            let trace_digest = export.metadata.seal_digest.clone();
            let audit_context = ProviderTraceExportAuditContextV1 {
                store: state.provider_trace_v1.clone(),
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                provider_turn_id: provider_turn_id.clone(),
                request_id: request_id.clone(),
                payload_digest: payload_digest.clone(),
                trace_digest: trace_digest.clone(),
            };
            if std::time::Instant::now() >= export.expires_at {
                drop(export.file);
                drop(io_guard);
                drop(export_permit);
                let (completion, completed) = tokio::sync::oneshot::channel();
                if acknowledgment
                    .send(ProviderTraceExportValidationAckV1::DeadlineExceeded { completion })
                    .is_err()
                {
                    return provider_trace_error_response(
                        PROVIDER_TRACE_TASK_FAILED_V1,
                        "Provider trace validation supervisor ended before deadline audit",
                    );
                }
                match completed.await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        return provider_trace_error_response(error.code, &error.message)
                    }
                    Err(_) => {
                        return provider_trace_error_response(
                            PROVIDER_TRACE_TASK_FAILED_V1,
                            "Provider trace validation supervisor failed during deadline audit",
                        )
                    }
                }
                return provider_trace_error_response(
                    PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1,
                    "Provider trace export capability deadline elapsed during archive validation",
                );
            }
            let body = provider_trace_export_body(
                export.file,
                export.byte_length,
                export.expires_at,
                io_guard,
                export_permit,
                audit_context,
            );
            let _ = acknowledgment.send(ProviderTraceExportValidationAckV1::BodyOwned);
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .header("x-content-type-options", "nosniff")
                .header(PROVIDER_TRACE_DIGEST_HEADER_V1, trace_digest)
                .body(body)
                .unwrap_or_else(|_| {
                    provider_trace_error_response(
                        "provider_trace_export_response_failed",
                        "Provider trace export response could not be built",
                    )
                })
        }
        ProviderTraceExportValidationDeliveryV1::Rejected(error) => {
            provider_trace_error_response(error.code, &error.message)
        }
        ProviderTraceExportValidationDeliveryV1::TaskFailed => provider_trace_error_response(
            PROVIDER_TRACE_TASK_FAILED_V1,
            "Provider trace export task failed",
        ),
    }
}

fn provider_trace_export_body(
    file: std::fs::File,
    byte_length: u64,
    deadline: std::time::Instant,
    io_guard: tokio::sync::OwnedRwLockReadGuard<()>,
    export_permit: ProviderTraceExportPermitV1,
    audit_context: ProviderTraceExportAuditContextV1,
) -> axum::body::Body {
    // The producer owns every resource that must converge even when Hyper stops
    // polling a backpressured Body. It performs only one bounded disk read at a
    // time and waits asynchronously for channel capacity between chunks.
    let (chunk_sender, mut chunk_receiver) = tokio::sync::mpsc::channel::<Bytes>(2);
    let (state_sender, mut state_receiver) =
        tokio::sync::watch::channel(ProviderTraceExportProducerStateV1::Active);
    let (delivery_sender, delivery_receiver) = tokio::sync::oneshot::channel::<()>();
    let (audit_sender, audit_receiver) =
        tokio::sync::oneshot::channel::<Result<(), ProviderTraceErrorV1>>();
    let producer_state_sender = state_sender.clone();
    let producer = tokio::spawn(async move {
        let mut io_guard = Some(io_guard);
        let mut export_permit = Some(export_permit);
        let mut file = Some(file);
        let mut remaining = byte_length;
        let result_code = loop {
            if std::time::Instant::now() >= deadline {
                let _ = state_sender.send(ProviderTraceExportProducerStateV1::DeadlineExceeded);
                break PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1;
            }
            if remaining == 0 {
                drop(chunk_sender);
                let _ = state_sender.send(ProviderTraceExportProducerStateV1::ReadyForDelivery);
                break tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(
                        tokio::time::Instant::from_std(deadline)
                    ) => {
                        let _ = state_sender.send(
                            ProviderTraceExportProducerStateV1::DeadlineExceeded,
                        );
                        PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1
                    }
                    delivered = delivery_receiver => {
                        if delivered.is_ok() && std::time::Instant::now() < deadline {
                            PROVIDER_TRACE_EXPORT_DELIVERED_V1
                        } else if std::time::Instant::now() >= deadline {
                            let _ = state_sender.send(
                                ProviderTraceExportProducerStateV1::DeadlineExceeded,
                            );
                            PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1
                        } else {
                            PROVIDER_TRACE_EXPORT_RECEIVER_CLOSED_V1
                        }
                    }
                };
            }

            let requested = remaining.min(PROVIDER_TRACE_EXPORT_CHUNK_BYTES_V1 as u64) as usize;
            let mut chunk_file = file.take().expect("Provider trace export file");
            let mut read_task = tokio::task::spawn_blocking(move || {
                let mut buffer = vec![0u8; requested];
                let result = loop {
                    match chunk_file.read(&mut buffer) {
                        Ok(0) => {
                            break Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "Verified Provider trace archive ended during export",
                            ));
                        }
                        Ok(read) => {
                            buffer.truncate(read);
                            break Ok(buffer);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => break Err(error),
                    }
                };
                (chunk_file, result)
            });
            let (returned_file, chunk) = tokio::select! {
                biased;
                _ = tokio::time::sleep_until(
                    tokio::time::Instant::from_std(deadline)
                ) => {
                    read_task.abort();
                    drop(io_guard.take());
                    drop(export_permit.take());
                    let _ = (&mut read_task).await;
                    let _ = state_sender.send(
                        ProviderTraceExportProducerStateV1::DeadlineExceeded,
                    );
                    break PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1;
                }
                result = &mut read_task => {
                    match result {
                        Ok(result) => result,
                        Err(_) => {
                            let _ = state_sender.send(
                                ProviderTraceExportProducerStateV1::ReaderTaskFailed,
                            );
                            break PROVIDER_TRACE_EXPORT_READER_TASK_FAILED_V1;
                        }
                    }
                }
            };
            file = Some(returned_file);
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = state_sender.send(ProviderTraceExportProducerStateV1::ReadFailed(
                        error.to_string(),
                    ));
                    break PROVIDER_TRACE_EXPORT_READ_FAILED_V1;
                }
            };
            remaining -= chunk.len() as u64;
            let send_result = tokio::select! {
                biased;
                _ = tokio::time::sleep_until(
                    tokio::time::Instant::from_std(deadline)
                ) => {
                    let _ = state_sender.send(
                        ProviderTraceExportProducerStateV1::DeadlineExceeded,
                    );
                    break PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1;
                }
                result = chunk_sender.send(Bytes::from(chunk)) => result,
            };
            if send_result.is_err() {
                break PROVIDER_TRACE_EXPORT_RECEIVER_CLOSED_V1;
            }
        };
        drop(file);
        drop(io_guard);
        drop(export_permit);
        result_code
    });
    tokio::spawn(async move {
        let result_code = match producer.await {
            Ok(result_code) => result_code,
            Err(_) => {
                let _ = producer_state_sender
                    .send(ProviderTraceExportProducerStateV1::ReaderTaskFailed);
                PROVIDER_TRACE_EXPORT_READER_TASK_FAILED_V1
            }
        };
        let audit_result =
            record_provider_trace_export_outcome("export", audit_context, result_code).await;
        let _ = audit_sender.send(audit_result);
    });

    let mut delivery_sender = Some(delivery_sender);
    let mut audit_receiver = Some(audit_receiver);
    let stream = async_stream::stream! {
        loop {
            let state = state_receiver.borrow().clone();
            match state {
                ProviderTraceExportProducerStateV1::DeadlineExceeded => {
                    let audit = audit_receiver.take().expect("Provider trace export audit").await;
                    if !matches!(audit, Ok(Ok(()))) {
                        yield Err(std::io::Error::other(
                            "Provider trace export audit could not be recorded",
                        ));
                    } else {
                        yield Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "Provider trace export capability deadline elapsed",
                        ));
                    }
                    return;
                }
                ProviderTraceExportProducerStateV1::ReadFailed(message) => {
                    let audit = audit_receiver.take().expect("Provider trace export audit").await;
                    if !matches!(audit, Ok(Ok(()))) {
                        yield Err(std::io::Error::other(
                            "Provider trace export audit could not be recorded",
                        ));
                    } else {
                        yield Err(std::io::Error::other(message));
                    }
                    return;
                }
                ProviderTraceExportProducerStateV1::ReaderTaskFailed => {
                    let audit = audit_receiver.take().expect("Provider trace export audit").await;
                    if !matches!(audit, Ok(Ok(()))) {
                        yield Err(std::io::Error::other(
                            "Provider trace export audit could not be recorded",
                        ));
                    } else {
                        yield Err(std::io::Error::other(
                            "Provider trace export reader task failed",
                        ));
                    }
                    return;
                }
                ProviderTraceExportProducerStateV1::Active
                | ProviderTraceExportProducerStateV1::ReadyForDelivery => {}
            }

            tokio::select! {
                biased;
                changed = state_receiver.changed() => {
                    if changed.is_err() {
                        yield Err(std::io::Error::other(
                            "Provider trace export producer ended without a terminal state",
                        ));
                        return;
                    }
                }
                chunk = chunk_receiver.recv() => {
                    match chunk {
                        Some(chunk) => {
                            if std::time::Instant::now() < deadline
                                && matches!(
                                    *state_receiver.borrow(),
                                    ProviderTraceExportProducerStateV1::Active
                                        | ProviderTraceExportProducerStateV1::ReadyForDelivery
                                )
                            {
                                yield Ok(chunk);
                            }
                        }
                        None => {
                            if matches!(
                                *state_receiver.borrow(),
                                ProviderTraceExportProducerStateV1::ReadyForDelivery
                            ) {
                                if std::time::Instant::now() >= deadline {
                                    if state_receiver.changed().await.is_err() {
                                        yield Err(std::io::Error::other(
                                            "Provider trace export producer ended without a terminal state",
                                        ));
                                        return;
                                    }
                                    continue;
                                }
                                if let Some(sender) = delivery_sender.take() {
                                    let _ = sender.send(());
                                }
                                let audit = audit_receiver
                                    .take()
                                    .expect("Provider trace export audit")
                                    .await;
                                if !matches!(audit, Ok(Ok(()))) {
                                    yield Err(std::io::Error::other(
                                        "Provider trace export audit could not be recorded",
                                    ));
                                } else {
                                    let final_state = state_receiver.borrow().clone();
                                    match final_state {
                                        ProviderTraceExportProducerStateV1::ReadyForDelivery => {}
                                        ProviderTraceExportProducerStateV1::DeadlineExceeded => {
                                            yield Err(std::io::Error::new(
                                                std::io::ErrorKind::TimedOut,
                                                "Provider trace export capability deadline elapsed",
                                            ));
                                        }
                                        ProviderTraceExportProducerStateV1::ReadFailed(message) => {
                                            yield Err(std::io::Error::other(message));
                                        }
                                        ProviderTraceExportProducerStateV1::ReaderTaskFailed
                                        | ProviderTraceExportProducerStateV1::Active => {
                                            yield Err(std::io::Error::other(
                                                "Provider trace export producer failed before delivery",
                                            ));
                                        }
                                    }
                                }
                                return;
                            }
                        }
                    }
                }
            }
        }
    };
    axum::body::Body::from_stream(stream)
}

async fn provider_trace_session_guard(
    state: &AppState,
    session_id: &str,
) -> Result<tokio::sync::OwnedRwLockReadGuard<()>, (&'static str, &'static str)> {
    let guard = session_private_io_lock(session_id).read_owned().await;
    let gui = state.gui.lock().expect("gui state lock");
    let session = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id));
    if session.is_none_or(session_is_deletion_tombstone) {
        return Err((
            "agent_session_deletion_in_progress",
            "Session Provider trace storage is unavailable because deletion is pending or complete.",
        ));
    }
    drop(gui);
    Ok(guard)
}

fn provider_trace_request_payload_digest(
    session_id: &str,
    run_id: &str,
    provider_turn_id: &str,
    trace_digest: &str,
    request_id: &str,
) -> String {
    stable_json_sha256(&json!({
        "schemaVersion": "deepcode.provider-trace-export-request.v1",
        "sessionId": session_id,
        "runId": run_id,
        "providerTurnId": provider_turn_id,
        "traceDigest": trace_digest,
        "requestId": request_id,
    }))
    .unwrap_or_else(|_| {
        sha256_prefixed(
            format!(
                "{session_id}\u{0}{run_id}\u{0}{provider_turn_id}\u{0}{trace_digest}\u{0}{request_id}"
            )
            .as_bytes(),
        )
    })
}

fn malformed_provider_trace_payload_digest(
    action: &str,
    session_id: &str,
    provider_turn_id: &str,
    result_code: &str,
) -> String {
    stable_json_sha256(&json!({
        "schemaVersion": "deepcode.provider-trace-malformed-request.v1",
        "action": action,
        "sessionId": session_id,
        "providerTurnId": provider_turn_id,
        "resultCode": result_code,
    }))
    .unwrap_or_else(|_| sha256_prefixed(result_code.as_bytes()))
}

async fn record_provider_trace_failure(
    state: &AppState,
    action: &str,
    session_id: &str,
    run_id: &str,
    provider_turn_id: &str,
    request_id: &str,
    payload_digest: &str,
    trace_digest: &str,
    result_code: &str,
) -> Result<(), Response> {
    let store = state.provider_trace_v1.clone();
    let action = action.to_string();
    let session_id = session_id.to_string();
    let run_id = run_id.to_string();
    let provider_turn_id = provider_turn_id.to_string();
    let request_id = request_id.to_string();
    let payload_digest = payload_digest.to_string();
    let trace_digest = trace_digest.to_string();
    let result_code = result_code.to_string();
    match tokio::task::spawn_blocking(move || {
        store.record_export_outcome(
            &action,
            &session_id,
            &run_id,
            &provider_turn_id,
            &request_id,
            &payload_digest,
            &trace_digest,
            &result_code,
        )
    })
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(provider_trace_error_response(
            "provider_trace_audit_write_failed",
            &format!(
                "Provider trace failure audit could not be recorded: {}",
                error.message
            ),
        )),
        Err(_) => Err(provider_trace_error_response(
            "provider_trace_audit_write_failed",
            "Provider trace failure audit task failed",
        )),
    }
}

fn provider_trace_error_response(code: &str, message: &str) -> Response {
    let payload = json!({
        "ok": false,
        "error": code,
        "message": message,
    });
    Response::builder()
        .status(
            if matches!(
                code,
                "provider_trace_audit_write_failed"
                    | "provider_trace_export_limiter_unavailable"
                    | PROVIDER_TRACE_TASK_FAILED_V1
            ) {
                StatusCode::INTERNAL_SERVER_ERROR
            } else if matches!(
                code,
                "provider_trace_export_session_busy" | "provider_trace_export_capacity_exceeded"
            ) {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
        )
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(
            serde_json::to_vec(&payload).unwrap_or_default(),
        ))
        .unwrap_or_else(|_| Response::new(axum::body::Body::empty()))
}

fn provider_trace_api_response(response: Json<ApiResponse>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(
            serde_json::to_vec(&response.0).unwrap_or_default(),
        ))
        .unwrap_or_else(|_| Response::new(axum::body::Body::empty()))
}
