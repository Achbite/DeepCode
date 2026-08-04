use crate::kernel_v2_transport::{
    apply_authorized_user_decision, decision_authorization_error, encode_bounded_json,
    wire_error_code, BoundedJsonEncodeErrorV2, KernelV2TransportState, MAX_V2_RESPONSE_BYTES,
};
use deepcode_kernel_abi::v2::{CommandRequestId, V2WireDecodeError};
use deepcode_kernel_abi::v2_command::{
    decode_kernel_command_v2, KernelCommandV2, MAX_COMMAND_BYTES_V2,
};
use deepcode_kernel_abi::{
    decode_user_decision_v2, KernelV2HttpErrorCode, KernelV2IpcErrorEnvelope, RunCapabilityV2,
    MAX_USER_DECISION_BYTES_V2,
};
use serde::Serialize;
use std::io::{self, ErrorKind, Read, Write};

pub(crate) enum KernelV2IpcPortV2 {
    SessionCommand {
        transport_run_capability: RunCapabilityV2,
    },
    UserDecision,
}

impl KernelV2IpcPortV2 {
    fn maximum_request_bytes(&self) -> usize {
        match self {
            Self::SessionCommand { .. } => MAX_COMMAND_BYTES_V2,
            Self::UserDecision => MAX_USER_DECISION_BYTES_V2,
        }
    }
}

#[derive(Clone)]
pub(crate) struct KernelV2IpcDispatcher {
    state: KernelV2TransportState,
}

pub(crate) struct KernelV2IpcDispatchV2 {
    response_body: Vec<u8>,
    run_capability: Option<RunCapabilityV2>,
}

impl KernelV2IpcDispatchV2 {
    pub(crate) fn into_parts(self) -> (Vec<u8>, Option<RunCapabilityV2>) {
        (self.response_body, self.run_capability)
    }

    fn response_only(response_body: Vec<u8>) -> Self {
        Self {
            response_body,
            run_capability: None,
        }
    }
}

impl KernelV2IpcDispatcher {
    pub(crate) fn new(state: KernelV2TransportState) -> Self {
        Self { state }
    }

    pub(crate) fn dispatch(&self, port: &KernelV2IpcPortV2, body: &[u8]) -> KernelV2IpcDispatchV2 {
        if body.len() > port.maximum_request_bytes() {
            return KernelV2IpcDispatchV2::response_only(encode_transport_error(
                KernelV2HttpErrorCode::PayloadTooLarge,
                None,
            ));
        }
        match port {
            KernelV2IpcPortV2::SessionCommand {
                transport_run_capability,
            } => KernelV2IpcDispatchV2::response_only(
                self.dispatch_session_command(body, transport_run_capability),
            ),
            KernelV2IpcPortV2::UserDecision => {
                KernelV2IpcDispatchV2::response_only(self.dispatch_user_decision(body))
            }
        }
    }

    pub(crate) fn serve_length_prefixed<R, W>(
        &self,
        port: &KernelV2IpcPortV2,
        reader: &mut R,
        writer: &mut W,
    ) -> io::Result<()>
    where
        R: Read,
        W: Write,
    {
        loop {
            let Some(length) = read_frame_length(reader)? else {
                return Ok(());
            };
            if length > port.maximum_request_bytes() {
                let response = encode_transport_error(KernelV2HttpErrorCode::PayloadTooLarge, None);
                write_length_prefixed(writer, &response)?;
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "Kernel v2 IPC frame exceeds the port limit",
                ));
            }
            let mut body = vec![0_u8; length];
            reader.read_exact(&mut body)?;
            let (response, run_capability) = self.dispatch(port, &body).into_parts();
            if run_capability.is_some() {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "framed Kernel v2 IPC cannot carry private Run capability metadata",
                ));
            }
            write_length_prefixed(writer, &response)?;
        }
    }

    fn dispatch_session_command(
        &self,
        body: &[u8],
        transport_run_capability: &RunCapabilityV2,
    ) -> Vec<u8> {
        let envelope = match decode_kernel_command_v2(body) {
            Ok(envelope) => envelope,
            Err(error) => return encode_wire_error(error),
        };
        let request_id = envelope.request_id.clone();
        if matches!(&envelope.command, KernelCommandV2::RunOpen(_)) {
            return encode_transport_error(
                KernelV2HttpErrorCode::HostAuthorityRequired,
                Some(request_id),
            );
        }
        match self
            .state
            .handle_session_command(envelope, transport_run_capability)
        {
            Ok(response) => encode_or_service_error(&response, Some(request_id)),
            Err(_) => {
                encode_transport_error(KernelV2HttpErrorCode::ServiceUnavailable, Some(request_id))
            }
        }
    }

    fn dispatch_user_decision(&self, body: &[u8]) -> Vec<u8> {
        let envelope = match decode_user_decision_v2(body) {
            Ok(envelope) => envelope,
            Err(error) => return encode_wire_error(error),
        };
        let request_id = envelope.request_id.clone();
        let permit = match self.state.decision_authority().authorize(&envelope) {
            Ok(permit) => permit,
            Err(error) => {
                return encode_transport_error(
                    decision_authorization_error(error).1,
                    Some(request_id),
                )
            }
        };
        match apply_authorized_user_decision(self.state.service(), permit, envelope) {
            Ok(response) => encode_or_service_error(&response, Some(request_id)),
            Err(code) => encode_transport_error(code, Some(request_id)),
        }
    }
}

fn read_frame_length(reader: &mut impl Read) -> io::Result<Option<usize>> {
    let mut length_bytes = [0_u8; 4];
    loop {
        match reader.read(&mut length_bytes[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "Kernel v2 IPC reader violated the Read contract",
                ))
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    if let Err(error) = reader.read_exact(&mut length_bytes[1..]) {
        if error.kind() == ErrorKind::UnexpectedEof {
            return Err(io::Error::new(
                ErrorKind::UnexpectedEof,
                "Kernel v2 IPC stream ended within a frame length prefix",
            ));
        }
        return Err(error);
    }
    Ok(Some(u32::from_be_bytes(length_bytes) as usize))
}

fn encode_wire_error(error: V2WireDecodeError) -> Vec<u8> {
    encode_transport_error(wire_error_code(error).1, None)
}

fn encode_transport_error(
    code: KernelV2HttpErrorCode,
    request_id: Option<CommandRequestId>,
) -> Vec<u8> {
    encode_bounded_json(&KernelV2IpcErrorEnvelope::new(code, request_id)).unwrap_or_else(|_| {
        b"{\"format\":\"deepcode.kernel.ipc-error.v2\",\"code\":\"service_unavailable\"}".to_vec()
    })
}

fn encode_or_service_error(
    value: &impl Serialize,
    request_id: Option<CommandRequestId>,
) -> Vec<u8> {
    match encode_bounded_json(value) {
        Ok(response) => response,
        Err(BoundedJsonEncodeErrorV2::TooLarge) => {
            encode_transport_error(KernelV2HttpErrorCode::ResponseTooLarge, request_id)
        }
        Err(BoundedJsonEncodeErrorV2::Serialization) => {
            encode_transport_error(KernelV2HttpErrorCode::ServiceUnavailable, request_id)
        }
    }
}

fn write_length_prefixed(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_V2_RESPONSE_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "Kernel v2 IPC response exceeds the transport limit",
        ));
    }
    let length = u32::try_from(body.len()).map_err(|_| {
        io::Error::new(
            ErrorKind::InvalidData,
            "Kernel v2 IPC response is too large",
        )
    })?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}
