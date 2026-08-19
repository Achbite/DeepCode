mod agent_input_v2;
mod config;
mod error;
mod host;
mod llm;
pub mod tool_protocol_v2;
pub mod transport_v2;
pub mod user_decision_v2;
pub mod v2;
pub mod v2_command;
mod workspace;

/// Live wire version. V2 module names are retained until the post-acceptance
/// cleanup, but no v2 wire payload is admitted by this build.
pub const KERNEL_ABI_V2_VERSION: &str = "deepcode.kernel.abi.v3";

pub use agent_input_v2::*;
pub use config::*;
pub use error::*;
pub use host::*;
pub use llm::*;
pub use tool_protocol_v2::*;
pub use transport_v2::*;
pub use user_decision_v2::*;
pub use workspace::*;
