use super::{Capability, CapabilityEffect, RiskLevel, WorkspaceBoundary};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_DIRECTORY_INDEX: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let index = TEST_DIRECTORY_INDEX.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "deepcode-policy-{}-{stamp}-{index}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create policy test directory");
        Self(path)
    }

    fn canonical_path(&self) -> PathBuf {
        self.0.canonicalize().expect("canonical test directory")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn capability_constructors_use_current_settings_ceiling_names() {
    assert_eq!(Capability::workspace_read().0, "workspace.read");
    assert_eq!(Capability::workspace_write().0, "workspace.write");
    assert_eq!(Capability::network_egress().0, "network.egress");
    assert_eq!(Capability::secret_read().0, "secret.read");
}

#[test]
fn policy_metadata_round_trips_as_descriptive_values() {
    let metadata = (
        Capability::workspace_write(),
        CapabilityEffect::WritesWorkspace,
        RiskLevel::High,
    );
    let encoded = serde_json::to_value(&metadata).expect("serialize policy metadata");
    let decoded: (Capability, CapabilityEffect, RiskLevel) =
        serde_json::from_value(encoded).expect("deserialize policy metadata");

    assert_eq!(decoded, metadata);
}

#[test]
fn workspace_boundary_rejects_escaped_paths() {
    let root = TestDirectory::new();
    let boundary = WorkspaceBoundary::new(&root.0);
    for path in ["/etc/passwd", "../secret.txt", "C:/Users/test/file.txt"] {
        assert!(
            boundary.resolve_read(path).is_err(),
            "{path} must not resolve through the workspace boundary"
        );
    }
    assert_eq!(
        boundary.resolve_read("src/main.rs").unwrap(),
        root.canonical_path().join("src/main.rs")
    );
}

#[cfg(unix)]
#[test]
fn workspace_boundary_allows_in_root_read_symlink_but_rejects_mutation() {
    use std::os::unix::fs::symlink;

    let root = TestDirectory::new();
    let target = root.0.join("target.txt");
    fs::write(&target, "value").expect("write symlink target");
    symlink(&target, root.0.join("link.txt")).expect("create in-root symlink");

    let boundary = WorkspaceBoundary::new(&root.0);
    assert_eq!(
        boundary.resolve_read("link.txt").unwrap(),
        target.canonicalize().expect("canonical symlink target")
    );
    assert!(boundary.resolve_mutation("link.txt").is_err());
}

#[cfg(unix)]
#[test]
fn workspace_boundary_rejects_out_of_root_symlink_reads_and_mutations() {
    use std::os::unix::fs::symlink;

    let root = TestDirectory::new();
    let external = TestDirectory::new();
    fs::write(external.0.join("outside.txt"), "value").expect("write external target");
    symlink(&external.0, root.0.join("outside")).expect("create outside symlink");

    let boundary = WorkspaceBoundary::new(&root.0);
    assert!(boundary.resolve_read("outside/outside.txt").is_err());
    assert!(boundary.resolve_mutation("outside/new-file.txt").is_err());
}

#[test]
fn workspace_boundary_rejects_root_as_mutation_target() {
    let root = TestDirectory::new();
    let boundary = WorkspaceBoundary::new(&root.0);

    assert!(boundary.resolve_mutation(".").is_err());
}

#[test]
fn workspace_boundary_blocks_protected_config_asset_mutation() {
    assert!(WorkspaceBoundary::assert_mutable_config_asset("src/lib.rs").is_ok());
    assert!(WorkspaceBoundary::assert_mutable_config_asset(".deepcode/policy/rules.json").is_err());
    assert!(
        WorkspaceBoundary::assert_mutable_config_asset(".deepcode\\skills\\demo.json").is_err()
    );
}
