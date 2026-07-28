use crate::decision_capability_v2::{
    CapabilityDecisionClassV2, DecisionCapabilityAuthorityV2,
    DecisionCapabilityAuthorizationErrorV2, DecisionCapabilityGrantV2,
    DecisionCapabilityIssueErrorV2, DecisionCapabilityPermitV2, DecisionCapabilitySubjectV2,
};
pub(crate) use crate::host_workspace_registry_v2::{
    HostWorkspaceBindingResolverV2, HostWorkspaceResolveErrorV2,
};
use axum::body::{Body, Bytes};
use axum::extract::rejection::BytesRejection;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use deepcode_kernel_abi::v2::{CommandRequestId, UserDecisionRefV2, V2WireDecodeError};
use deepcode_kernel_abi::v2_command::{
    decode_kernel_command_v2, CommandHandlingV2, KernelCommandEnvelopeV2,
    KernelCommandResponseEnvelopeV2, KernelCommandV2, KernelErrorV2,
};
use deepcode_kernel_abi::{
    decode_user_decision_v2, CapabilityScopePreviewIdV2, RunCapabilityV2, UserDecisionEnvelopeV2,
    UserDecisionErrorV2, UserDecisionReplyV2, UserDecisionResponseEnvelopeV2, UserDecisionV2,
    KERNEL_ABI_V2_VERSION,
};
use deepcode_kernel_runtime::v2::{
    KernelSessionServiceV2, PendingCapabilityDecisionClassV2, SettingsCeilingV2,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Write};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const KERNEL_V2_COMMANDS_PATH: &str = "/api/kernel/v2/commands";
pub(crate) const KERNEL_V2_USER_DECISIONS_PATH: &str = "/api/kernel/v2/user-decisions";
pub(crate) const HOST_TRANSPORT_CAPABILITY_HEADER: &str = "x-deepcode-host-capability";
pub(crate) const RUN_TRANSPORT_CAPABILITY_HEADER: &str = "x-deepcode-run-capability";
pub(crate) const MAX_V2_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

pub(crate) trait HostRunSettingsResolverV2: Send + Sync {
    fn resolve_run_settings(
        &self,
        workspace_binding_ref: &deepcode_kernel_abi::WorkspaceBindingRefV2,
    ) -> Result<SettingsCeilingV2, HostWorkspaceResolveErrorV2>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostCapabilityDecisionKindV2 {
    Allow,
    Deny,
}

pub(crate) struct HostCapabilityDecisionRequestV2 {
    pub(crate) request_id: CommandRequestId,
    pub(crate) decision_ref: UserDecisionRefV2,
    pub(crate) scope_preview_id: CapabilityScopePreviewIdV2,
    pub(crate) decision: HostCapabilityDecisionKindV2,
    pub(crate) guidance: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostCapabilityDecisionApplyErrorV2 {
    Kernel(UserDecisionErrorV2),
    Transport(KernelV2HttpErrorCode),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KernelV2HttpErrorCode {
    PayloadTooLarge,
    InvalidJson,
    DuplicateJsonKey,
    MissingAbiVersion,
    InvalidAbiVersion,
    UnsupportedAbiVersion,
    InvalidPayload,
    HostAuthorityRequired,
    HostAuthorityInvalid,
    RunCapabilityRequired,
    RunCapabilityInvalid,
    WorkspaceBindingNotFound,
    WorkspaceBindingStale,
    WorkspaceBindingUnavailable,
    DecisionCapabilityRequired,
    DecisionCapabilityInvalid,
    DecisionCapabilityExpired,
    DecisionCapabilityBindingMismatch,
    DecisionCapabilityRequestConflict,
    DecisionCapabilityInUse,
    ResponseTooLarge,
    ServiceUnavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelV2TransportErrorEnvelope {
    pub(crate) format: &'static str,
    pub(crate) code: KernelV2HttpErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_id: Option<CommandRequestId>,
}

#[derive(Clone)]
pub(crate) struct HostTransportAuthorityV2 {
    capability_digest: Arc<[u8; 32]>,
}

#[derive(Clone)]
pub(crate) struct HostTransportCapabilityV2(String);

impl fmt::Debug for HostTransportCapabilityV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostTransportCapabilityV2([REDACTED])")
    }
}

impl HostTransportCapabilityV2 {
    pub(crate) fn expose_to_host_transport(&self) -> &str {
        &self.0
    }
}

impl HostTransportAuthorityV2 {
    pub(crate) fn new_pair() -> std::io::Result<(Self, HostTransportCapabilityV2)> {
        let mut entropy = [0_u8; 32];
        File::open("/dev/urandom")?.read_exact(&mut entropy)?;
        let capability = format!("dcv2h_{}", encode_hex(&entropy));
        Ok((
            Self {
                capability_digest: Arc::new(sha256(capability.as_bytes())),
            },
            HostTransportCapabilityV2(capability),
        ))
    }

    fn authorize(&self, headers: &HeaderMap) -> Result<(), KernelV2HttpErrorCode> {
        let Some(submitted) = headers
            .get(HOST_TRANSPORT_CAPABILITY_HEADER)
            .and_then(|value| value.to_str().ok())
        else {
            return Err(KernelV2HttpErrorCode::HostAuthorityRequired);
        };
        self.authorize_token(submitted)
    }

    pub(crate) fn authorize_token(&self, submitted: &str) -> Result<(), KernelV2HttpErrorCode> {
        let submitted_digest = sha256(submitted.as_bytes());
        if constant_time_eq(self.capability_digest.as_ref(), &submitted_digest) {
            Ok(())
        } else {
            Err(KernelV2HttpErrorCode::HostAuthorityInvalid)
        }
    }
}

#[derive(Clone)]
pub(crate) struct KernelV2TransportState {
    service: KernelSessionServiceV2,
    workspace_resolver: Arc<dyn HostWorkspaceBindingResolverV2>,
    settings_resolver: Arc<dyn HostRunSettingsResolverV2>,
    host_authority: HostTransportAuthorityV2,
    decision_authority: DecisionCapabilityAuthorityV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KernelV2TransportStartupError {
    DecisionCapabilityEntropyUnavailable,
}

impl KernelV2TransportState {
    pub(crate) fn new(
        service: KernelSessionServiceV2,
        workspace_resolver: Arc<dyn HostWorkspaceBindingResolverV2>,
        settings_resolver: Arc<dyn HostRunSettingsResolverV2>,
        host_authority: HostTransportAuthorityV2,
    ) -> Result<Self, KernelV2TransportStartupError> {
        let decision_authority = DecisionCapabilityAuthorityV2::new()
            .map_err(|_| KernelV2TransportStartupError::DecisionCapabilityEntropyUnavailable)?;
        Ok(Self {
            service,
            workspace_resolver,
            settings_resolver,
            host_authority,
            decision_authority,
        })
    }

    pub(crate) fn issue_user_decision_capability(
        &self,
        grant: DecisionCapabilityGrantV2,
        lifetime: Duration,
    ) -> Result<deepcode_kernel_abi::DecisionCapabilityV2, DecisionCapabilityIssueErrorV2> {
        self.decision_authority.issue(grant, lifetime)
    }

    /// Applies a trusted UI decision without ever returning the short-lived
    /// decision capability to Session, the browser, or a JSON payload.
    pub(crate) fn apply_host_capability_decision(
        &self,
        request: HostCapabilityDecisionRequestV2,
    ) -> Result<UserDecisionResponseEnvelopeV2, HostCapabilityDecisionApplyErrorV2> {
        let pending = self
            .service
            .resolve_pending_capability_decision_host(
                request.scope_preview_id,
                request.decision_ref,
            )
            .map_err(|_| {
                HostCapabilityDecisionApplyErrorV2::Transport(
                    KernelV2HttpErrorCode::ServiceUnavailable,
                )
            })?
            .map_err(HostCapabilityDecisionApplyErrorV2::Kernel)?;
        let (class, decision) = match (pending.class, request.decision) {
            (PendingCapabilityDecisionClassV2::Capability, HostCapabilityDecisionKindV2::Allow) => {
                (
                    CapabilityDecisionClassV2::Capability,
                    UserDecisionV2::CapabilityAllow(pending.binding.clone()),
                )
            }
            (PendingCapabilityDecisionClassV2::Capability, HostCapabilityDecisionKindV2::Deny) => (
                CapabilityDecisionClassV2::Capability,
                UserDecisionV2::CapabilityDeny {
                    binding: pending.binding.clone(),
                    guidance: request.guidance,
                },
            ),
            (
                PendingCapabilityDecisionClassV2::ScopeExpansion,
                HostCapabilityDecisionKindV2::Allow,
            ) => (
                CapabilityDecisionClassV2::ScopeExpansion,
                UserDecisionV2::ScopeExpansionAllow(pending.binding.clone()),
            ),
            (
                PendingCapabilityDecisionClassV2::ScopeExpansion,
                HostCapabilityDecisionKindV2::Deny,
            ) => (
                CapabilityDecisionClassV2::ScopeExpansion,
                UserDecisionV2::ScopeExpansionDeny {
                    binding: pending.binding.clone(),
                    guidance: request.guidance,
                },
            ),
        };
        let capability = self
            .issue_user_decision_capability(
                DecisionCapabilityGrantV2 {
                    run_id: pending.run_id.clone(),
                    expected_control_epoch: pending.expected_control_epoch,
                    subject: DecisionCapabilitySubjectV2::Capability {
                        class,
                        binding: pending.binding,
                    },
                },
                Duration::from_secs(60),
            )
            .map_err(|_| {
                HostCapabilityDecisionApplyErrorV2::Transport(
                    KernelV2HttpErrorCode::ServiceUnavailable,
                )
            })?;
        let envelope = UserDecisionEnvelopeV2::new(
            request.request_id,
            pending.run_id,
            capability,
            pending.expected_control_epoch,
            decision,
        );
        let permit = self
            .decision_authority
            .authorize(&envelope)
            .map_err(|error| {
                HostCapabilityDecisionApplyErrorV2::Transport(decision_authorization_error(error).1)
            })?;
        apply_authorized_user_decision(self.service.clone(), permit, envelope)
            .map_err(HostCapabilityDecisionApplyErrorV2::Transport)
    }

    /// Opens a Run through the typed in-process Host boundary. The caller
    /// supplies the exact Settings ceiling resolved for this workspace; no
    /// process-private Host token or global Settings re-resolution is needed.
    pub(crate) fn open_run_host_with_settings(
        &self,
        envelope: KernelCommandEnvelopeV2,
        settings: SettingsCeilingV2,
    ) -> Result<
        (KernelCommandResponseEnvelopeV2, Option<RunCapabilityV2>),
        HostWorkspaceResolveErrorV2,
    > {
        let workspace_binding_ref = match &envelope.command {
            KernelCommandV2::RunOpen(command) => command.workspace_binding_ref.clone(),
            _ => return Err(HostWorkspaceResolveErrorV2::Unavailable),
        };
        let workspace_root = self
            .workspace_resolver
            .resolve_workspace_binding(&workspace_binding_ref)?;
        if !workspace_root.is_absolute() {
            return Err(HostWorkspaceResolveErrorV2::Unavailable);
        }
        Ok(self
            .service
            .open_run(envelope, &workspace_root, settings)
            .into_parts())
    }

    pub(crate) fn service(&self) -> KernelSessionServiceV2 {
        self.service.clone()
    }

    pub(crate) fn workspace_resolver(&self) -> Arc<dyn HostWorkspaceBindingResolverV2> {
        Arc::clone(&self.workspace_resolver)
    }

    pub(crate) fn settings_resolver(&self) -> Arc<dyn HostRunSettingsResolverV2> {
        Arc::clone(&self.settings_resolver)
    }

    pub(crate) fn host_authority(&self) -> HostTransportAuthorityV2 {
        self.host_authority.clone()
    }

    pub(crate) fn decision_authority(&self) -> DecisionCapabilityAuthorityV2 {
        self.decision_authority.clone()
    }
}

pub(crate) async fn kernel_v2_commands(
    State(state): State<KernelV2TransportState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(_) => {
            return http_error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                KernelV2HttpErrorCode::PayloadTooLarge,
                None,
            )
        }
    };
    let envelope = match decode_kernel_command_v2(&body) {
        Ok(envelope) => envelope,
        Err(error) => return wire_error_response(error),
    };
    let request_id = envelope.request_id.clone();
    match &envelope.command {
        KernelCommandV2::RunOpen(command) => {
            if let Err(code) = state.host_authority.authorize(&headers) {
                return http_error_response(auth_status(code), code, Some(request_id));
            }
            let workspace_binding_ref = command.workspace_binding_ref.clone();
            let workspace_resolver = Arc::clone(&state.workspace_resolver);
            let settings_resolver = Arc::clone(&state.settings_resolver);
            let service = state.service.clone();
            let opened = tokio::task::spawn_blocking(move || {
                let workspace_root =
                    workspace_resolver.resolve_workspace_binding(&workspace_binding_ref)?;
                if !workspace_root.is_absolute() {
                    return Err(HostWorkspaceResolveErrorV2::Unavailable);
                }
                let settings = settings_resolver.resolve_run_settings(&workspace_binding_ref)?;
                Ok(service.open_run(envelope, &workspace_root, settings))
            })
            .await;
            match opened {
                Ok(Ok(opened)) => {
                    let (response, run_capability) = opened.into_parts();
                    no_store_run_open_json(
                        StatusCode::OK,
                        response,
                        run_capability.as_ref(),
                        Some(request_id),
                    )
                }
                Ok(Err(error)) => {
                    let (status, code) = workspace_error(error);
                    http_error_response(status, code, Some(request_id))
                }
                Err(_) => http_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    KernelV2HttpErrorCode::ServiceUnavailable,
                    Some(request_id),
                ),
            }
        }
        _ => {
            let transport_run_capability = match transport_run_capability(&headers) {
                Ok(capability) => capability,
                Err(code) => {
                    return http_error_response(StatusCode::UNAUTHORIZED, code, Some(request_id))
                }
            };
            let service = state.service.clone();
            let handled = tokio::task::spawn_blocking(move || {
                service.handle_session_command(envelope, &transport_run_capability)
            })
            .await;
            match handled {
                Ok(response) => no_store_json(StatusCode::OK, response, Some(request_id)),
                Err(_) => http_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    KernelV2HttpErrorCode::ServiceUnavailable,
                    Some(request_id),
                ),
            }
        }
    }
}

pub(crate) async fn kernel_v2_user_decisions(
    State(state): State<KernelV2TransportState>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(_) => {
            return http_error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                KernelV2HttpErrorCode::PayloadTooLarge,
                None,
            )
        }
    };
    let envelope = match decode_user_decision_v2(&body) {
        Ok(envelope) => envelope,
        Err(error) => return wire_error_response(error),
    };
    let request_id = envelope.request_id.clone();
    let permit = match state.decision_authority.authorize(&envelope) {
        Ok(permit) => permit,
        Err(error) => {
            let (status, code) = decision_authorization_error(error);
            return http_error_response(status, code, Some(request_id));
        }
    };
    let service = state.service.clone();
    let decided = tokio::task::spawn_blocking(move || {
        apply_authorized_user_decision(service, permit, envelope)
    })
    .await;
    match decided {
        Ok(Ok(response)) => no_store_json(StatusCode::OK, response, Some(request_id)),
        Ok(Err(code)) => {
            http_error_response(StatusCode::SERVICE_UNAVAILABLE, code, Some(request_id))
        }
        Err(_) => http_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            KernelV2HttpErrorCode::ServiceUnavailable,
            Some(request_id),
        ),
    }
}

pub(crate) fn apply_authorized_user_decision(
    service: KernelSessionServiceV2,
    permit: DecisionCapabilityPermitV2,
    envelope: UserDecisionEnvelopeV2,
) -> Result<UserDecisionResponseEnvelopeV2, KernelV2HttpErrorCode> {
    let request_id = envelope.request_id.clone();
    let decision = service.apply_host_user_decision(
        request_id.clone(),
        envelope.run_id,
        envelope.expected_control_epoch,
        envelope.decision,
    );
    let (reply, handling) = match decision {
        Ok(durable) => durable,
        Err(KernelErrorV2::DuplicateCommandDigestMismatch { .. }) => (
            UserDecisionReplyV2::Error(UserDecisionErrorV2::DuplicateRequestDigestMismatch),
            CommandHandlingV2::Evaluated,
        ),
        Err(_) => return Err(KernelV2HttpErrorCode::ServiceUnavailable),
    };
    let response = UserDecisionResponseEnvelopeV2::Correlated {
        server_abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
        request_id,
        handling,
        reply,
    };
    permit
        .complete()
        .map_err(|_| KernelV2HttpErrorCode::ServiceUnavailable)?;
    Ok(response)
}

fn transport_run_capability(headers: &HeaderMap) -> Result<RunCapabilityV2, KernelV2HttpErrorCode> {
    let submitted = headers
        .get(RUN_TRANSPORT_CAPABILITY_HEADER)
        .ok_or(KernelV2HttpErrorCode::RunCapabilityRequired)?;
    submitted
        .to_str()
        .ok()
        .and_then(|value| RunCapabilityV2::new(value.to_owned()).ok())
        .ok_or(KernelV2HttpErrorCode::RunCapabilityInvalid)
}

fn wire_error_response(error: V2WireDecodeError) -> Response {
    let (status, code) = wire_error_code(error);
    http_error_response(status, code, None)
}

pub(crate) fn wire_error_code(error: V2WireDecodeError) -> (StatusCode, KernelV2HttpErrorCode) {
    match error {
        V2WireDecodeError::PayloadTooLarge { .. } => (
            StatusCode::PAYLOAD_TOO_LARGE,
            KernelV2HttpErrorCode::PayloadTooLarge,
        ),
        V2WireDecodeError::InvalidJson => {
            (StatusCode::BAD_REQUEST, KernelV2HttpErrorCode::InvalidJson)
        }
        V2WireDecodeError::DuplicateKey => (
            StatusCode::BAD_REQUEST,
            KernelV2HttpErrorCode::DuplicateJsonKey,
        ),
        V2WireDecodeError::MissingAbiVersion => (
            StatusCode::BAD_REQUEST,
            KernelV2HttpErrorCode::MissingAbiVersion,
        ),
        V2WireDecodeError::InvalidAbiVersion => (
            StatusCode::BAD_REQUEST,
            KernelV2HttpErrorCode::InvalidAbiVersion,
        ),
        V2WireDecodeError::UnsupportedAbiVersion { .. } => (
            StatusCode::UPGRADE_REQUIRED,
            KernelV2HttpErrorCode::UnsupportedAbiVersion,
        ),
        V2WireDecodeError::InvalidPayload(_) | V2WireDecodeError::Validation(_) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            KernelV2HttpErrorCode::InvalidPayload,
        ),
    }
}

fn auth_status(code: KernelV2HttpErrorCode) -> StatusCode {
    match code {
        KernelV2HttpErrorCode::HostAuthorityRequired => StatusCode::UNAUTHORIZED,
        _ => StatusCode::FORBIDDEN,
    }
}

pub(crate) fn workspace_error(
    error: HostWorkspaceResolveErrorV2,
) -> (StatusCode, KernelV2HttpErrorCode) {
    match error {
        HostWorkspaceResolveErrorV2::NotFound => (
            StatusCode::NOT_FOUND,
            KernelV2HttpErrorCode::WorkspaceBindingNotFound,
        ),
        HostWorkspaceResolveErrorV2::Stale => (
            StatusCode::CONFLICT,
            KernelV2HttpErrorCode::WorkspaceBindingStale,
        ),
        HostWorkspaceResolveErrorV2::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            KernelV2HttpErrorCode::WorkspaceBindingUnavailable,
        ),
    }
}

pub(crate) fn decision_authorization_error(
    error: DecisionCapabilityAuthorizationErrorV2,
) -> (StatusCode, KernelV2HttpErrorCode) {
    match error {
        DecisionCapabilityAuthorizationErrorV2::Required => (
            StatusCode::UNAUTHORIZED,
            KernelV2HttpErrorCode::DecisionCapabilityRequired,
        ),
        DecisionCapabilityAuthorizationErrorV2::Invalid => (
            StatusCode::FORBIDDEN,
            KernelV2HttpErrorCode::DecisionCapabilityInvalid,
        ),
        DecisionCapabilityAuthorizationErrorV2::Expired => (
            StatusCode::GONE,
            KernelV2HttpErrorCode::DecisionCapabilityExpired,
        ),
        DecisionCapabilityAuthorizationErrorV2::BindingMismatch => (
            StatusCode::FORBIDDEN,
            KernelV2HttpErrorCode::DecisionCapabilityBindingMismatch,
        ),
        DecisionCapabilityAuthorizationErrorV2::RequestConflict => (
            StatusCode::CONFLICT,
            KernelV2HttpErrorCode::DecisionCapabilityRequestConflict,
        ),
        DecisionCapabilityAuthorizationErrorV2::InUse => (
            StatusCode::CONFLICT,
            KernelV2HttpErrorCode::DecisionCapabilityInUse,
        ),
        DecisionCapabilityAuthorizationErrorV2::Internal => (
            StatusCode::SERVICE_UNAVAILABLE,
            KernelV2HttpErrorCode::ServiceUnavailable,
        ),
    }
}

fn http_error_response(
    status: StatusCode,
    code: KernelV2HttpErrorCode,
    request_id: Option<CommandRequestId>,
) -> Response {
    let envelope = KernelV2TransportErrorEnvelope {
        format: "deepcode.kernel.http-error.v2",
        code,
        request_id,
    };
    let body = encode_bounded_json(&envelope).unwrap_or_else(|_| {
        b"{\"format\":\"deepcode.kernel.http-error.v2\",\"code\":\"service_unavailable\"}".to_vec()
    });
    json_bytes_response(status, body)
}

fn no_store_json(
    status: StatusCode,
    body: impl Serialize,
    request_id: Option<CommandRequestId>,
) -> Response {
    match encode_bounded_json(&body) {
        Ok(body) => json_bytes_response(status, body),
        Err(BoundedJsonEncodeErrorV2::TooLarge) => http_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            KernelV2HttpErrorCode::ResponseTooLarge,
            request_id,
        ),
        Err(BoundedJsonEncodeErrorV2::Serialization) => http_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            KernelV2HttpErrorCode::ServiceUnavailable,
            request_id,
        ),
    }
}

fn no_store_run_open_json(
    status: StatusCode,
    body: impl Serialize,
    run_capability: Option<&RunCapabilityV2>,
    request_id: Option<CommandRequestId>,
) -> Response {
    let mut response = no_store_json(status, body, request_id.clone());
    let Some(run_capability) = run_capability else {
        return response;
    };
    let header_value = match HeaderValue::from_str(run_capability.expose_to_transport()) {
        Ok(value) => value,
        Err(_) => {
            return http_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                KernelV2HttpErrorCode::ServiceUnavailable,
                request_id,
            )
        }
    };
    response
        .headers_mut()
        .insert(RUN_TRANSPORT_CAPABILITY_HEADER, header_value);
    response
}

fn json_bytes_response(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BoundedJsonEncodeErrorV2 {
    TooLarge,
    Serialization,
}

pub(crate) fn encode_bounded_json(
    value: &impl Serialize,
) -> Result<Vec<u8>, BoundedJsonEncodeErrorV2> {
    let mut writer = BoundedResponseWriterV2::new(MAX_V2_RESPONSE_BYTES);
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok(writer.bytes),
        Err(_) if writer.exceeded => Err(BoundedJsonEncodeErrorV2::TooLarge),
        Err(_) => Err(BoundedJsonEncodeErrorV2::Serialization),
    }
}

struct BoundedResponseWriterV2 {
    bytes: Vec<u8>,
    maximum: usize,
    exceeded: bool,
}

impl BoundedResponseWriterV2 {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(8 * 1024),
            maximum,
            exceeded: false,
        }
    }
}

impl Write for BoundedResponseWriterV2 {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let Some(next_length) = self.bytes.len().checked_add(buffer.len()) else {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Kernel v2 response exceeds the transport limit",
            ));
        };
        if next_length > self.maximum {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Kernel v2 response exceeds the transport limit",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn sha256(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn encode_hex(value: &[u8]) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
