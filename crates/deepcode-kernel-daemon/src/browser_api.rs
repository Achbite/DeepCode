use crate::prelude::*;
use crate::*;

fn unavailable(capability: HostCapability) -> Json<ApiResponse> {
    let fact = HostCapabilityUnavailable {
        capability,
        reason: HostCapabilityUnavailableReason::BackendUnavailable,
    };
    ApiResponse::error_with_data(
        "host_capability_unavailable",
        "The packaged host has no active browser backend.",
        serde_json::to_value(fact).expect("host capability availability must serialize"),
    )
}

pub(crate) async fn browser_status() -> Json<ApiResponse> {
    unavailable(HostCapability::BrowserRuntime)
}

pub(crate) async fn browser_open(Json(_body): Json<Value>) -> Json<ApiResponse> {
    unavailable(HostCapability::BrowserRuntime)
}

pub(crate) async fn browser_reload() -> Json<ApiResponse> {
    unavailable(HostCapability::BrowserRuntime)
}

pub(crate) async fn browser_inspect_mode(Json(_body): Json<Value>) -> Json<ApiResponse> {
    unavailable(HostCapability::BrowserRuntime)
}
