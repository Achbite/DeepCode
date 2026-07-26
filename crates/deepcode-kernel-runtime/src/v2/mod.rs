mod authority;
mod model;

pub(crate) use authority::AuthorityRuntime;
pub(crate) use model::{
    AuthorityError, CapabilityScope, EffectCompletion, GrantIssueRequest, GrantLifecycle,
    GrantReservationLifecycle, InvocationLifecycle, InvocationSubmitRequest,
    TerminalInvocationOutcome,
};
