use super::*;

#[test]
fn kernel_snapshot_is_recoverable_without_gui_state() {
    let snapshot = KernelSnapshot {
        session_id: Some(SessionId("session-1".to_string())),
        run_id: Some(RunId("run-1".to_string())),
        workspace_binding: Some(WorkspaceBinding {
            workspace_id: Some("ws-1".to_string()),
            workspace_hash: Some("hash-1".to_string()),
            open_path: None,
            active_folder_id: Some("wf-0".to_string()),
            folder_hash: None,
        }),
        config_ref: Some(ConfigSnapshotRef {
            snapshot_id: "cfg-1".to_string(),
            hash: Some("cfg-hash".to_string()),
        }),
        workflow_phase: Some("plan".to_string()),
        pending_stage: None,
        events: vec![KernelEventSummary {
            id: Some("evt-1".to_string()),
            kind: "run.started".to_string(),
            sequence: Some(1),
            summary: Some("Run started".to_string()),
        }],
        pending_permission: None,
        updated_at: Some("2026-05-26T00:00:00Z".to_string()),
    };

    let encoded = serde_json::to_value(&snapshot).expect("serialize snapshot");
    assert!(encoded.get("panelState").is_none());
    assert!(encoded.get("editorState").is_none());
    assert_eq!(encoded["workspaceBinding"]["activeFolderId"], "wf-0");

    let decoded: KernelSnapshot = serde_json::from_value(encoded).expect("deserialize snapshot");
    assert_eq!(decoded, snapshot);
}
