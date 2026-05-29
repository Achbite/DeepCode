use deepcode_kernel_policy::Capability;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokeredScriptRequest {
    pub request_id: String,
    pub invocation_id: String,
    pub capability: Capability,
    pub method: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokeredScriptResponse {
    pub request_id: String,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<String>,
}

pub trait ScriptBroker {
    fn dispatch(&self, request: BrokeredScriptRequest) -> BrokeredScriptResponse;
}

#[derive(Debug, Default)]
pub struct DisabledScriptBroker;

impl ScriptBroker for DisabledScriptBroker {
    fn dispatch(&self, request: BrokeredScriptRequest) -> BrokeredScriptResponse {
        BrokeredScriptResponse {
            request_id: request.request_id,
            ok: false,
            output: None,
            error: Some("script broker is an interface placeholder for stage 9".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_broker_fails_closed() {
        let broker = DisabledScriptBroker;
        let response = broker.dispatch(BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_read(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        });

        assert!(!response.ok);
        assert_eq!(response.request_id, "broker-1");
        assert!(response.error.unwrap().contains("stage 9"));
    }
}
