use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_tools::{PlannedOperation, WorkUnitGraph};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct SerialWorkUnitScheduler<'a> {
    operations: Vec<&'a PlannedOperation>,
    pub(crate) graph: WorkUnitGraph,
}

impl<'a> SerialWorkUnitScheduler<'a> {
    pub(crate) fn build(operations: &'a [PlannedOperation]) -> KernelResult<Self> {
        let graph = WorkUnitGraph::from_operations(operations);
        let by_id = operations
            .iter()
            .map(|operation| (operation.id.as_str(), operation))
            .collect::<BTreeMap<_, _>>();
        let mut dependencies = operations
            .iter()
            .map(|operation| {
                (
                    operation.id.as_str(),
                    operation
                        .depends_on
                        .iter()
                        .map(String::as_str)
                        .collect::<BTreeSet<_>>(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        for operation in operations {
            for dependency in &operation.depends_on {
                if !by_id.contains_key(dependency.as_str()) {
                    return Err(KernelError::InvalidCommand(format!(
                        "operation {} depends on unknown operation {}",
                        operation.id, dependency
                    )));
                }
            }
        }
        let mut ordered = Vec::with_capacity(operations.len());
        let mut completed = BTreeSet::new();
        while ordered.len() < operations.len() {
            let Some(operation) = operations.iter().find(|operation| {
                !completed.contains(operation.id.as_str())
                    && dependencies
                        .get(operation.id.as_str())
                        .is_some_and(|required| required.iter().all(|id| completed.contains(id)))
            }) else {
                return Err(KernelError::InvalidCommand(
                    "operation dependency graph contains a cycle".to_string(),
                ));
            };
            completed.insert(operation.id.as_str());
            ordered.push(operation);
            dependencies.remove(operation.id.as_str());
        }
        Ok(Self {
            operations: ordered,
            graph,
        })
    }

    pub(crate) fn operations(&self) -> impl Iterator<Item = &'a PlannedOperation> + '_ {
        self.operations.iter().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_tools::{
        OperationExecutionMode, PlannedOperationKind, ToolOperationKind, WorkspaceOperation,
        WorkspaceOperationKind,
    };

    fn operation(id: &str, depends_on: &[&str]) -> PlannedOperation {
        PlannedOperation {
            id: id.to_string(),
            title: id.to_string(),
            tool_id: "fs.read".to_string(),
            operation_kind: ToolOperationKind::FsRead,
            depends_on: depends_on.iter().map(|value| value.to_string()).collect(),
            capability: "workspace.read".to_string(),
            permission_labels: Vec::new(),
            target_ref: None,
            read_set: vec![id.to_string()],
            write_set: Vec::new(),
            conflict_keys: vec![id.to_string()],
            execution_mode: OperationExecutionMode::Execute,
            operation: PlannedOperationKind::Workspace(Box::new(WorkspaceOperation {
                kind: WorkspaceOperationKind::Read,
                target_path: Some(id.to_string()),
                target_kind: None,
                recursive: false,
                content_block_id: None,
                replacement_block_id: None,
                content: None,
                patch_spec: None,
                allow_empty_content: false,
                temporary: false,
                executable: false,
                query: None,
                pattern: None,
                depth: None,
                include_hidden: false,
                include: Vec::new(),
                exclude: Vec::new(),
                strategy: None,
                context_lines: None,
                max_results: None,
                rename_to: None,
                start_line: None,
                end_line: None,
                start_page: None,
                end_page: None,
            })),
        }
    }

    #[test]
    fn serial_scheduler_obeys_dependencies() {
        let operations = vec![operation("second", &["first"]), operation("first", &[])];
        let scheduler = SerialWorkUnitScheduler::build(&operations).expect("valid graph");
        assert_eq!(
            scheduler
                .operations()
                .map(|operation| operation.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn serial_scheduler_rejects_cycles() {
        let operations = vec![
            operation("first", &["second"]),
            operation("second", &["first"]),
        ];
        let error = SerialWorkUnitScheduler::build(&operations)
            .err()
            .expect("cycle fails");
        assert!(error.to_string().contains("cycle"));
    }
}
