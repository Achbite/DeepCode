use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub mod v2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEvent {
    pub id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: String,
    pub sequence: Option<u64>,
    pub payload: Value,
    pub created_at: Option<String>,
}

pub trait EventLedger: Send + Sync {
    fn append(&self, event: LedgerEvent) -> KernelResult<()>;
    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()>;
    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>>;
    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>>;
    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>>;

    fn next_sequence(&self, run_id: &str) -> KernelResult<u64> {
        Ok(self
            .list_by_run(run_id)?
            .into_iter()
            .filter_map(|event| event.sequence)
            .max()
            .unwrap_or(0)
            + 1)
    }
}

#[derive(Debug, Default)]
pub struct InMemoryEventLedger {
    events: Mutex<Vec<LedgerEvent>>,
}

impl InMemoryEventLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn all(&self) -> KernelResult<Vec<LedgerEvent>> {
        Ok(self.events.lock().expect("ledger lock").clone())
    }

    pub fn next_sequence(&self, run_id: &str) -> KernelResult<u64> {
        EventLedger::next_sequence(self, run_id)
    }
}

impl EventLedger for InMemoryEventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        self.events.lock().expect("ledger lock").push(event);
        Ok(())
    }

    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        self.events.lock().expect("ledger lock").extend(events);
        Ok(())
    }

    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        self.all()
    }

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        Ok(self
            .events
            .lock()
            .expect("ledger lock")
            .iter()
            .filter(|event| event.run_id.as_deref() == Some(run_id))
            .cloned()
            .collect())
    }

    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        Ok(self
            .events
            .lock()
            .expect("ledger lock")
            .iter()
            .filter(|event| event.session_id.as_deref() == Some(session_id))
            .cloned()
            .collect())
    }
}

#[derive(Debug, Clone)]
pub struct NdjsonEventLedger {
    path: PathBuf,
}

impl NdjsonEventLedger {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn replay_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(&self.path)
            .map_err(|error| KernelError::Other(format!("open ledger failed: {error}")))?;
        let mut events = Vec::new();
        for line in BufReader::new(file).lines() {
            let line =
                line.map_err(|error| KernelError::Other(format!("read ledger failed: {error}")))?;
            if line.trim().is_empty() {
                continue;
            }
            events.push(serde_json::from_str::<LedgerEvent>(&line).map_err(|error| {
                KernelError::Other(format!("decode ledger event failed: {error}"))
            })?);
        }
        Ok(events)
    }
}

impl EventLedger for NdjsonEventLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                KernelError::Other(format!("create ledger directory failed: {error}"))
            })?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| KernelError::Other(format!("open ledger append failed: {error}")))?;
        let encoded = serde_json::to_string(&event)
            .map_err(|error| KernelError::Other(format!("encode ledger event failed: {error}")))?;
        writeln!(file, "{encoded}")
            .map_err(|error| KernelError::Other(format!("write ledger event failed: {error}")))
    }

    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        if events.is_empty() {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                KernelError::Other(format!("create ledger directory failed: {error}"))
            })?;
        }
        let mut encoded = Vec::new();
        for event in events {
            serde_json::to_writer(&mut encoded, &event).map_err(|error| {
                KernelError::Other(format!("encode ledger event failed: {error}"))
            })?;
            encoded.push(b'\n');
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| KernelError::Other(format!("open ledger append failed: {error}")))?;
        file.write_all(&encoded).map_err(|error| {
            KernelError::Other(format!("write ledger event batch failed: {error}"))
        })
    }

    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        self.replay_all()
    }

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        let mut events = self
            .replay_all()?
            .into_iter()
            .filter(|event| event.run_id.as_deref() == Some(run_id))
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence.unwrap_or_default());
        Ok(events)
    }

    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        let mut events = self
            .replay_all()?
            .into_iter()
            .filter(|event| event.session_id.as_deref() == Some(session_id))
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence.unwrap_or_default());
        Ok(events)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOperation {
    pub id: String,
    pub work_unit_id: Option<String>,
    pub kind: String,
    pub file_path: String,
    pub diff: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub id: String,
    pub run_id: String,
    pub operations: Vec<ChangeOperation>,
    pub touched_files: Vec<String>,
    pub diff_summary: String,
}

impl ChangeSet {
    pub fn from_operations(
        id: impl Into<String>,
        run_id: impl Into<String>,
        operations: Vec<ChangeOperation>,
    ) -> Self {
        let mut touched = BTreeSet::new();
        for operation in &operations {
            touched.insert(operation.file_path.clone());
        }
        let touched_files = touched.into_iter().collect::<Vec<_>>();
        Self {
            id: id.into(),
            run_id: run_id.into(),
            diff_summary: format!("{} file(s) changed", touched_files.len()),
            operations,
            touched_files,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValidationKind {
    Test,
    Lint,
    Typecheck,
    Format,
    Policy,
    SecretScan,
    ManualReview,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub id: String,
    pub run_id: String,
    pub kind: ValidationKind,
    pub passed: bool,
    pub summary: String,
    pub evidence_refs: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn event(id: &str, run_id: &str, sequence: u64) -> LedgerEvent {
        LedgerEvent {
            id: id.to_string(),
            run_id: Some(run_id.to_string()),
            session_id: Some("session-1".to_string()),
            kind: "test.event".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({ "id": id }),
            created_at: None,
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("deepcode-{label}-{nonce}"))
    }

    #[test]
    fn in_memory_ledger_appends_and_lists_by_run() {
        let ledger = InMemoryEventLedger::new();
        ledger.append(event("evt-1", "run-1", 1)).unwrap();
        ledger.append(event("evt-2", "run-2", 1)).unwrap();
        ledger.append(event("evt-3", "run-1", 2)).unwrap();

        let run_events = ledger.list_by_run("run-1").unwrap();
        assert_eq!(run_events.len(), 2);
        assert_eq!(ledger.next_sequence("run-1").unwrap(), 3);
    }

    #[test]
    fn ndjson_ledger_appends_and_replays_in_sequence_order() {
        let root = temp_root("ledger");
        let ledger_path = root.join("events.ndjson");
        let ledger = NdjsonEventLedger::new(&ledger_path);
        ledger.append(event("evt-2", "run-1", 2)).unwrap();
        ledger.append(event("evt-1", "run-1", 1)).unwrap();

        let run_events = ledger.list_by_run("run-1").unwrap();
        assert_eq!(run_events.len(), 2);
        assert_eq!(run_events[0].id, "evt-1");
        assert_eq!(run_events[1].id, "evt-2");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn change_set_collects_unique_touched_files() {
        let change_set = ChangeSet::from_operations(
            "cs-1",
            "run-1",
            vec![
                ChangeOperation {
                    id: "op-1".to_string(),
                    work_unit_id: None,
                    kind: "write".to_string(),
                    file_path: "a.rs".to_string(),
                    diff: None,
                },
                ChangeOperation {
                    id: "op-2".to_string(),
                    work_unit_id: None,
                    kind: "edit".to_string(),
                    file_path: "a.rs".to_string(),
                    diff: None,
                },
            ],
        );

        assert_eq!(change_set.touched_files, vec!["a.rs"]);
    }
}
