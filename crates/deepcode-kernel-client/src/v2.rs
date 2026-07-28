use crate::KernelClientConfig;
use deepcode_kernel_abi::v2::CommandRequestId;
use deepcode_kernel_abi::v2_command::{
    KernelCommandEnvelopeV2, KernelCommandResponseEnvelopeV2, KernelCommandV2, KernelReplyV2,
};
use deepcode_kernel_abi::{
    RunCapabilityV2, UserDecisionEnvelopeV2, UserDecisionResponseEnvelopeV2, KERNEL_ABI_V2_VERSION,
};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use std::fmt;
use std::net::IpAddr;
use thiserror::Error;

const KERNEL_V2_COMMANDS_PATH: &str = "/api/kernel/v2/commands";
const KERNEL_V2_USER_DECISIONS_PATH: &str = "/api/kernel/v2/user-decisions";
const HOST_TRANSPORT_CAPABILITY_HEADER: &str = "x-deepcode-host-capability";
const RUN_TRANSPORT_CAPABILITY_HEADER: &str = "x-deepcode-run-capability";
const MAX_V2_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelV2HttpErrorCode {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KernelV2HttpErrorEnvelope {
    format: String,
    code: KernelV2HttpErrorCode,
    request_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum KernelV2ClientError {
    #[error("Kernel v2 transport failed")]
    Transport(#[source] reqwest::Error),
    #[error("Kernel v2 HTTP request was rejected with {status}: {code:?}")]
    Http {
        status: StatusCode,
        code: KernelV2HttpErrorCode,
        request_id: Option<String>,
    },
    #[error("Kernel v2 response used an unsupported HTTP error format")]
    InvalidHttpError,
    #[error("Kernel v2 response decode failed")]
    Decode(#[source] serde_json::Error),
    #[error("Kernel v2 HTTP base URL must be an absolute loopback IP HTTP origin")]
    InvalidBaseUrl,
    #[error("Kernel v2 response exceeded the {maximum}-byte transport limit")]
    ResponseTooLarge { maximum: usize },
    #[error("Kernel v2 response used an unsupported server ABI version")]
    UnsupportedServerAbiVersion,
    #[error("Kernel v2 response requestId did not match the request")]
    ResponseRequestIdMismatch,
    #[error("Kernel v2 returned an uncorrelated response to a correlated request")]
    UncorrelatedResponse,
    #[error("Session Kernel client cannot open a Run")]
    RunOpenRequiresHost,
    #[error("Host Kernel open client accepts only RunOpen")]
    HostOpenCommandRequired,
    #[error("Host transport credential is malformed")]
    InvalidHostTransportCredential,
    #[error("Host RunOpen response is missing its private Run capability")]
    RunCapabilityMissing,
    #[error("Host RunOpen response carried a malformed private Run capability")]
    RunCapabilityInvalid,
    #[error("Kernel returned a private Run capability for a non-RunOpened response")]
    UnexpectedRunCapability,
}

pub type KernelV2ClientResult<T> = Result<T, KernelV2ClientError>;

#[derive(Clone)]
struct KernelV2HttpTransport {
    commands_url: Url,
    user_decisions_url: Url,
    http: reqwest::Client,
}

#[derive(Clone)]
pub struct SessionKernelV2Client {
    transport: KernelV2HttpTransport,
    run_capability: RunCapabilityV2,
}

#[derive(Clone)]
pub struct HostKernelV2Client {
    transport: KernelV2HttpTransport,
    host_credential: HostTransportCredentialV2,
}

pub struct HostRunOpenTransportV2 {
    response: KernelCommandResponseEnvelopeV2,
    run_capability: Option<RunCapabilityV2>,
}

impl HostRunOpenTransportV2 {
    pub fn into_parts(self) -> (KernelCommandResponseEnvelopeV2, Option<RunCapabilityV2>) {
        (self.response, self.run_capability)
    }
}

#[derive(Clone)]
pub struct HostDecisionKernelV2Client {
    transport: KernelV2HttpTransport,
}

#[derive(Clone)]
pub struct HostTransportCredentialV2(String);

impl fmt::Debug for HostTransportCredentialV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostTransportCredentialV2([REDACTED])")
    }
}

impl HostTransportCredentialV2 {
    pub fn new(value: impl Into<String>) -> KernelV2ClientResult<Self> {
        let value = value.into();
        if value.len() < 16
            || value.len() > 2048
            || !value
                .as_bytes()
                .iter()
                .all(|byte| (0x21..=0x7e).contains(byte))
        {
            return Err(KernelV2ClientError::InvalidHostTransportCredential);
        }
        Ok(Self(value))
    }
}

impl SessionKernelV2Client {
    pub fn new(
        config: KernelClientConfig,
        run_capability: RunCapabilityV2,
    ) -> KernelV2ClientResult<Self> {
        Ok(Self {
            transport: KernelV2HttpTransport::new(config)?,
            run_capability,
        })
    }

    pub async fn command(
        &self,
        envelope: KernelCommandEnvelopeV2,
    ) -> KernelV2ClientResult<KernelCommandResponseEnvelopeV2> {
        if matches!(&envelope.command, KernelCommandV2::RunOpen(_)) {
            return Err(KernelV2ClientError::RunOpenRequiresHost);
        }
        self.transport
            .post_command(
                envelope,
                Some((
                    RUN_TRANSPORT_CAPABILITY_HEADER,
                    self.run_capability.expose_to_transport(),
                )),
            )
            .await
    }
}

impl HostKernelV2Client {
    pub fn new(
        config: KernelClientConfig,
        host_credential: HostTransportCredentialV2,
    ) -> KernelV2ClientResult<Self> {
        Ok(Self {
            transport: KernelV2HttpTransport::new(config)?,
            host_credential,
        })
    }

    pub async fn open_run(
        &self,
        envelope: KernelCommandEnvelopeV2,
    ) -> KernelV2ClientResult<HostRunOpenTransportV2> {
        if !matches!(&envelope.command, KernelCommandV2::RunOpen(_)) {
            return Err(KernelV2ClientError::HostOpenCommandRequired);
        }
        self.transport
            .post_host_run_open(envelope, self.host_credential.0.as_str())
            .await
    }
}

impl HostDecisionKernelV2Client {
    pub fn new(config: KernelClientConfig) -> KernelV2ClientResult<Self> {
        Ok(Self {
            transport: KernelV2HttpTransport::new(config)?,
        })
    }

    pub async fn submit(
        &self,
        envelope: UserDecisionEnvelopeV2,
    ) -> KernelV2ClientResult<UserDecisionResponseEnvelopeV2> {
        self.transport.post_user_decision(envelope).await
    }
}

impl KernelV2HttpTransport {
    fn new(config: KernelClientConfig) -> KernelV2ClientResult<Self> {
        let base_url = parse_loopback_http_base_url(&config.base_url)?;
        let commands_url = base_url
            .join(KERNEL_V2_COMMANDS_PATH.trim_start_matches('/'))
            .map_err(|_| KernelV2ClientError::InvalidBaseUrl)?;
        let user_decisions_url = base_url
            .join(KERNEL_V2_USER_DECISIONS_PATH.trim_start_matches('/'))
            .map_err(|_| KernelV2ClientError::InvalidBaseUrl)?;
        Ok(Self {
            commands_url,
            user_decisions_url,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .map_err(KernelV2ClientError::Transport)?,
        })
    }

    async fn post_command(
        &self,
        envelope: KernelCommandEnvelopeV2,
        credential: Option<(&'static str, &str)>,
    ) -> KernelV2ClientResult<KernelCommandResponseEnvelopeV2> {
        let request_id = envelope.request_id.clone();
        let mut request = self.http.post(self.commands_url.clone()).json(&envelope);
        if let Some((name, value)) = credential {
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .map_err(KernelV2ClientError::Transport)?;
        let decoded = decode_response(response, &request_id).await?;
        validate_command_response(&decoded, &request_id)?;
        Ok(decoded)
    }

    async fn post_user_decision(
        &self,
        envelope: UserDecisionEnvelopeV2,
    ) -> KernelV2ClientResult<UserDecisionResponseEnvelopeV2> {
        let request_id = envelope.request_id.clone();
        let response = self
            .http
            .post(self.user_decisions_url.clone())
            .json(&envelope)
            .send()
            .await
            .map_err(KernelV2ClientError::Transport)?;
        let decoded = decode_response(response, &request_id).await?;
        validate_user_decision_response(&decoded, &request_id)?;
        Ok(decoded)
    }

    async fn post_host_run_open(
        &self,
        envelope: KernelCommandEnvelopeV2,
        host_credential: &str,
    ) -> KernelV2ClientResult<HostRunOpenTransportV2> {
        let request_id = envelope.request_id.clone();
        let response = self
            .http
            .post(self.commands_url.clone())
            .header(HOST_TRANSPORT_CAPABILITY_HEADER, host_credential)
            .json(&envelope)
            .send()
            .await
            .map_err(KernelV2ClientError::Transport)?;
        let run_capability = response
            .headers()
            .get(RUN_TRANSPORT_CAPABILITY_HEADER)
            .map(|value| {
                value
                    .to_str()
                    .ok()
                    .and_then(|value| RunCapabilityV2::new(value.to_owned()).ok())
                    .ok_or(KernelV2ClientError::RunCapabilityInvalid)
            })
            .transpose()?;
        let decoded = decode_response(response, &request_id).await?;
        validate_command_response(&decoded, &request_id)?;
        let run_opened = matches!(
            &decoded,
            KernelCommandResponseEnvelopeV2::Correlated {
                reply: KernelReplyV2::RunOpened(_),
                ..
            }
        );
        match (run_opened, run_capability.as_ref()) {
            (true, None) => return Err(KernelV2ClientError::RunCapabilityMissing),
            (false, Some(_)) => return Err(KernelV2ClientError::UnexpectedRunCapability),
            _ => {}
        }
        Ok(HostRunOpenTransportV2 {
            response: decoded,
            run_capability,
        })
    }
}

async fn decode_response<T>(
    mut response: reqwest::Response,
    expected_request_id: &CommandRequestId,
) -> KernelV2ClientResult<T>
where
    T: serde::de::DeserializeOwned,
{
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_V2_RESPONSE_BYTES as u64)
    {
        return Err(KernelV2ClientError::ResponseTooLarge {
            maximum: MAX_V2_RESPONSE_BYTES,
        });
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(64 * 1024)
            .min(MAX_V2_RESPONSE_BYTES),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(KernelV2ClientError::Transport)?
    {
        let next_length =
            body.len()
                .checked_add(chunk.len())
                .ok_or(KernelV2ClientError::ResponseTooLarge {
                    maximum: MAX_V2_RESPONSE_BYTES,
                })?;
        if next_length > MAX_V2_RESPONSE_BYTES {
            return Err(KernelV2ClientError::ResponseTooLarge {
                maximum: MAX_V2_RESPONSE_BYTES,
            });
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let error = serde_json::from_slice::<KernelV2HttpErrorEnvelope>(&body)
            .map_err(|_| KernelV2ClientError::InvalidHttpError)?;
        if error.format != "deepcode.kernel.http-error.v2" {
            return Err(KernelV2ClientError::InvalidHttpError);
        }
        if error
            .request_id
            .as_deref()
            .is_some_and(|request_id| request_id != expected_request_id.as_str())
        {
            return Err(KernelV2ClientError::ResponseRequestIdMismatch);
        }
        return Err(KernelV2ClientError::Http {
            status,
            code: error.code,
            request_id: error.request_id,
        });
    }
    serde_json::from_slice(&body).map_err(KernelV2ClientError::Decode)
}

fn parse_loopback_http_base_url(value: &str) -> KernelV2ClientResult<Url> {
    if value.trim() != value {
        return Err(KernelV2ClientError::InvalidBaseUrl);
    }
    let mut url = Url::parse(value).map_err(|_| KernelV2ClientError::InvalidBaseUrl)?;
    let authority = value
        .split_once("://")
        .map(|(_, remainder)| remainder.split(['/', '?', '#']).next().unwrap_or_default())
        .ok_or(KernelV2ClientError::InvalidBaseUrl)?;
    let host = url
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .ok_or(KernelV2ClientError::InvalidBaseUrl)?;
    if url.scheme() != "http"
        || !host.is_loopback()
        || authority.contains('@')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(KernelV2ClientError::InvalidBaseUrl);
    }
    url.set_path("/");
    Ok(url)
}

fn validate_command_response(
    response: &KernelCommandResponseEnvelopeV2,
    expected_request_id: &CommandRequestId,
) -> KernelV2ClientResult<()> {
    match response {
        KernelCommandResponseEnvelopeV2::Correlated {
            server_abi_version,
            request_id,
            ..
        } => validate_response_identity(server_abi_version, Some(request_id), expected_request_id),
        KernelCommandResponseEnvelopeV2::UncorrelatedWireFailure {
            server_abi_version, ..
        } => {
            validate_response_identity(server_abi_version, None, expected_request_id)?;
            Err(KernelV2ClientError::UncorrelatedResponse)
        }
    }
}

fn validate_user_decision_response(
    response: &UserDecisionResponseEnvelopeV2,
    expected_request_id: &CommandRequestId,
) -> KernelV2ClientResult<()> {
    match response {
        UserDecisionResponseEnvelopeV2::Correlated {
            server_abi_version,
            request_id,
            ..
        } => validate_response_identity(server_abi_version, Some(request_id), expected_request_id),
        UserDecisionResponseEnvelopeV2::UncorrelatedWireFailure {
            server_abi_version, ..
        } => {
            validate_response_identity(server_abi_version, None, expected_request_id)?;
            Err(KernelV2ClientError::UncorrelatedResponse)
        }
    }
}

fn validate_response_identity(
    server_abi_version: &str,
    response_request_id: Option<&CommandRequestId>,
    expected_request_id: &CommandRequestId,
) -> KernelV2ClientResult<()> {
    if server_abi_version != KERNEL_ABI_V2_VERSION {
        return Err(KernelV2ClientError::UnsupportedServerAbiVersion);
    }
    if response_request_id.is_some_and(|request_id| request_id != expected_request_id) {
        return Err(KernelV2ClientError::ResponseRequestIdMismatch);
    }
    Ok(())
}
