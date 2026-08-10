use deepcode_kernel_abi::{
    v2::{CommandRequestId, RunId},
    v2_command::{KernelCommandEnvelopeV2, KernelCommandV2, ToolContextGetV2},
    KERNEL_ABI_V2_VERSION,
};

#[test]
fn crate_root_exposes_the_v2_command_modules() {
    let envelope = KernelCommandEnvelopeV2::new(
        CommandRequestId::new("root-request-1").expect("request id"),
        KernelCommandV2::ToolContextGet(ToolContextGetV2 {
            run_id: RunId::new("run-root-1").expect("run id"),
            known_context: None,
        }),
    );
    assert_eq!(envelope.abi_version, KERNEL_ABI_V2_VERSION);
    assert_eq!(envelope.command.kind(), "toolContextGet");
    envelope.validate().expect("public v2 command is valid");
}
