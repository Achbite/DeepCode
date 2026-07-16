use crate::PlannedOperation;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitGraph {
    pub nodes: Vec<WorkUnitGraphNode>,
    pub edges: Vec<WorkUnitGraphEdge>,
    pub concurrency_groups: Vec<WorkUnitConcurrencyGroup>,
}

impl WorkUnitGraph {
    pub fn from_operations(operations: &[PlannedOperation]) -> Self {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut last_writer_by_key = BTreeMap::<String, String>::new();
        for operation in operations {
            let node_id = operation.id.clone();
            for dependency in &operation.depends_on {
                edges.push(WorkUnitGraphEdge {
                    from: dependency.clone(),
                    to: node_id.clone(),
                    reason: "explicitDependency".to_string(),
                });
            }
            for key in operation.read_set.iter().chain(operation.write_set.iter()) {
                if let Some(writer) = last_writer_by_key.get(key) {
                    if !edges
                        .iter()
                        .any(|edge| edge.from == *writer && edge.to == node_id)
                    {
                        edges.push(WorkUnitGraphEdge {
                            from: writer.clone(),
                            to: node_id.clone(),
                            reason: format!("conflict:{key}"),
                        });
                    }
                }
            }
            if operation.is_write_like() {
                for key in operation
                    .conflict_keys
                    .iter()
                    .chain(operation.write_set.iter())
                {
                    last_writer_by_key.insert(key.clone(), node_id.clone());
                }
            }
            nodes.push(WorkUnitGraphNode {
                id: node_id,
                operation_id: operation.id.clone(),
                can_run_concurrently: !operation.is_write_like(),
                read_set: operation.read_set.clone(),
                write_set: operation.write_set.clone(),
                conflict_keys: operation.conflict_keys.clone(),
            });
        }

        let mut read_validation = Vec::new();
        let mut serial_mutation = Vec::new();
        for node in &nodes {
            if node.can_run_concurrently {
                read_validation.push(node.id.clone());
            } else {
                serial_mutation.push(node.id.clone());
            }
        }
        let mut concurrency_groups = Vec::new();
        if !read_validation.is_empty() {
            concurrency_groups.push(WorkUnitConcurrencyGroup {
                id: "read-validation".to_string(),
                mode: "parallel".to_string(),
                node_ids: read_validation,
            });
        }
        if !serial_mutation.is_empty() {
            concurrency_groups.push(WorkUnitConcurrencyGroup {
                id: "mutation-serial".to_string(),
                mode: "serial".to_string(),
                node_ids: serial_mutation,
            });
        }
        Self {
            nodes,
            edges,
            concurrency_groups,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitGraphNode {
    pub id: String,
    pub operation_id: String,
    pub can_run_concurrently: bool,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitGraphEdge {
    pub from: String,
    pub to: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitConcurrencyGroup {
    pub id: String,
    pub mode: String,
    pub node_ids: Vec<String>,
}
