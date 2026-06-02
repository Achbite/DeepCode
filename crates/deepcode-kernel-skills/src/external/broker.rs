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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerAuthorization {
    pub method: String,
    pub capability: Capability,
}

#[derive(Debug, Clone, Default)]
pub struct ScriptBrokerPolicy {
    approved_capabilities: Vec<Capability>,
}

impl ScriptBrokerPolicy {
    pub fn new(approved_capabilities: Vec<Capability>) -> Self {
        Self {
            approved_capabilities,
        }
    }

    pub fn authorize(
        &self,
        request: &BrokeredScriptRequest,
    ) -> Result<BrokerAuthorization, String> {
        let expected = capability_for_broker_method(&request.method)
            .ok_or_else(|| format!("unsupported broker method {}", request.method))?;
        if request.capability != expected {
            return Err(format!(
                "broker request capability mismatch: method {} requires {} but request asked for {}",
                request.method, expected.0, request.capability.0
            ));
        }
        if !self.approved_capabilities.contains(&expected) {
            return Err(format!(
                "broker request requires unapproved capability {}",
                expected.0
            ));
        }
        Ok(BrokerAuthorization {
            method: request.method.clone(),
            capability: expected,
        })
    }
}

pub fn capability_for_broker_method(method: &str) -> Option<Capability> {
    match method {
        "kernel.fs.read" => Some(Capability::workspace_read()),
        "kernel.fs.write" => Some(Capability::workspace_write()),
        "kernel.code.search" => Some(Capability::workspace_search()),
        "kernel.network.fetch" => Some(Capability::network_egress()),
        "kernel.secret.read" => Some(Capability::secret_read()),
        "kernel.shell.exec" => Some(Capability::process_exec()),
        "kernel.context.attach" => Some(Capability::workspace_read()),
        "kernel.temp.create" => Some(Capability::workspace_create()),
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct DisabledScriptBroker;

impl ScriptBroker for DisabledScriptBroker {
    fn dispatch(&self, request: BrokeredScriptRequest) -> BrokeredScriptResponse {
        BrokeredScriptResponse {
            request_id: request.request_id,
            ok: false,
            output: None,
            error: Some("script broker has no runtime adapter attached".to_string()),
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
        assert!(response.error.unwrap().contains("no runtime adapter"));
    }

    #[test]
    fn broker_policy_authorizes_only_declared_methods_and_capabilities() {
        let policy = ScriptBrokerPolicy::new(vec![Capability::workspace_read()]);
        let request = BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_read(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        };

        let authorization = policy.authorize(&request).unwrap();
        assert_eq!(authorization.capability, Capability::workspace_read());

        let mut write_request = request.clone();
        write_request.method = "kernel.fs.write".to_string();
        write_request.capability = Capability::workspace_write();
        let error = policy.authorize(&write_request).unwrap_err();
        assert!(error.contains("unapproved capability"));
    }

    #[test]
    fn broker_policy_rejects_capability_mismatch() {
        let policy = ScriptBrokerPolicy::new(vec![Capability::workspace_read()]);
        let request = BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_write(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        };

        let error = policy.authorize(&request).unwrap_err();
        assert!(error.contains("capability mismatch"));
    }
}
