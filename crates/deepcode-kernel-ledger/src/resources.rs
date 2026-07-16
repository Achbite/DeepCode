use crate::{
    KernelResource, KernelResourceOwner, KernelResourceReleaseResult, KernelResourceState,
};
use deepcode_kernel_abi::{KernelError, KernelResult};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub struct KernelResourceAcquireBatchResult {
    pub resources: Vec<KernelResource>,
    pub acquired_resource_ids: Vec<String>,
    pub reused_resource_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct KernelResourceManagerState {
    resources: BTreeMap<String, KernelResource>,
    resource_ids_by_idempotency_key: BTreeMap<String, String>,
}

/// Owns one resource domain and keeps acquisition identity separate from logical scope.
///
/// The persistence callback runs before new leases become visible. Callers use it to append the
/// authoritative ledger fact, so a persistence failure cannot leave a partially active batch.
#[derive(Debug, Default)]
pub struct KernelResourceManager {
    state: Mutex<KernelResourceManagerState>,
}

impl KernelResourceManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire_batch<F>(
        &self,
        candidates: Vec<KernelResource>,
        persist: F,
    ) -> KernelResult<KernelResourceAcquireBatchResult>
    where
        F: FnOnce(&[KernelResource]) -> KernelResult<()>,
    {
        let mut state = self.state.lock().expect("resource manager lock");
        let mut batch_resource_ids = BTreeSet::new();
        let mut batch_idempotency_keys = BTreeSet::new();
        let mut resolved = Vec::with_capacity(candidates.len());
        let mut new_resources = Vec::new();
        let mut reused_resource_ids = Vec::new();

        for mut candidate in candidates {
            if candidate.resource_id.trim().is_empty()
                || candidate.logical_key.trim().is_empty()
                || candidate.idempotency_key.trim().is_empty()
            {
                return Err(resource_conflict(
                    "resource_lease_conflict",
                    "resource acquisition requires non-empty resourceId, logicalKey, and idempotencyKey",
                    &candidate,
                ));
            }
            if !batch_resource_ids.insert(candidate.resource_id.clone())
                || !batch_idempotency_keys.insert(candidate.idempotency_key.clone())
            {
                return Err(resource_conflict(
                    "resource_lease_conflict",
                    "resource acquisition batch contains duplicate identity",
                    &candidate,
                ));
            }

            if let Some(existing_id) = state
                .resource_ids_by_idempotency_key
                .get(&candidate.idempotency_key)
            {
                let existing = state
                    .resources
                    .get(existing_id)
                    .expect("idempotency index references a resource");
                if existing.state != KernelResourceState::Active {
                    return Err(resource_conflict(
                        "resource_lease_terminal",
                        "resource idempotency key belongs to a terminal lease",
                        existing,
                    ));
                }
                if !same_acquisition(existing, &candidate) {
                    return Err(resource_conflict(
                        "resource_lease_conflict",
                        "active resource idempotency key has different lease metadata",
                        &candidate,
                    ));
                }
                reused_resource_ids.push(existing.resource_id.clone());
                resolved.push(existing.clone());
                continue;
            }

            if state.resources.contains_key(&candidate.resource_id) {
                return Err(resource_conflict(
                    "resource_lease_conflict",
                    "resource instance ID is already registered with another idempotency key",
                    &candidate,
                ));
            }
            if candidate.created_at.is_none() {
                candidate.created_at = Some(unix_timestamp_millis());
            }
            resolved.push(candidate.clone());
            new_resources.push(candidate);
        }

        if !new_resources.is_empty() {
            persist(&new_resources)?;
            for resource in &new_resources {
                state.resource_ids_by_idempotency_key.insert(
                    resource.idempotency_key.clone(),
                    resource.resource_id.clone(),
                );
                state
                    .resources
                    .insert(resource.resource_id.clone(), resource.clone());
            }
        }

        Ok(KernelResourceAcquireBatchResult {
            resources: resolved,
            acquired_resource_ids: new_resources
                .iter()
                .map(|resource| resource.resource_id.clone())
                .collect(),
            reused_resource_ids,
        })
    }

    pub fn get(&self, resource_id: &str) -> Option<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .get(resource_id)
            .cloned()
    }

    pub fn list(&self) -> Vec<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .values()
            .cloned()
            .collect()
    }

    pub fn active_by_owner(&self, owner: &KernelResourceOwner) -> Vec<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .values()
            .filter(|resource| {
                resource.state == KernelResourceState::Active && resource.owner.matches(owner)
            })
            .cloned()
            .collect()
    }

    pub fn active_by_logical_key(&self, logical_key: &str) -> Vec<KernelResource> {
        self.state
            .lock()
            .expect("resource manager lock")
            .resources
            .values()
            .filter(|resource| {
                resource.state == KernelResourceState::Active && resource.logical_key == logical_key
            })
            .cloned()
            .collect()
    }

    pub fn release<F>(
        &self,
        resource_id: &str,
        persist: F,
    ) -> KernelResult<KernelResourceReleaseResult>
    where
        F: FnOnce(&KernelResource) -> KernelResult<()>,
    {
        let mut state = self.state.lock().expect("resource manager lock");
        let Some(resource) = state.resources.get_mut(resource_id) else {
            return Ok(KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: false,
                error: Some("resource not found".to_string()),
            });
        };
        if resource.state == KernelResourceState::Released {
            return Ok(KernelResourceReleaseResult {
                resource_id: resource_id.to_string(),
                released: true,
                error: None,
            });
        }
        let mut released_resource = resource.clone();
        released_resource.state = KernelResourceState::Released;
        released_resource.released_at = Some(unix_timestamp_millis());
        persist(&released_resource)?;
        *resource = released_resource;
        Ok(KernelResourceReleaseResult {
            resource_id: resource_id.to_string(),
            released: true,
            error: None,
        })
    }

    pub fn release_by_owner<F>(
        &self,
        owner: &KernelResourceOwner,
        mut persist: F,
    ) -> KernelResult<Vec<KernelResourceReleaseResult>>
    where
        F: FnMut(&KernelResource) -> KernelResult<()>,
    {
        let ids = self
            .active_by_owner(owner)
            .into_iter()
            .map(|resource| resource.resource_id)
            .collect::<Vec<_>>();
        ids.into_iter()
            .map(|id| self.release(&id, |resource| persist(resource)))
            .collect()
    }

    pub fn restore_released(&self, released_resource: KernelResource) -> KernelResult<()> {
        if released_resource.state != KernelResourceState::Released
            || released_resource.released_at.is_none()
        {
            return Err(resource_conflict(
                "resource_lease_restore_invalid",
                "restored terminal resource must include released state and releasedAt",
                &released_resource,
            ));
        }
        let mut state = self.state.lock().expect("resource manager lock");
        let Some(existing) = state.resources.get_mut(&released_resource.resource_id) else {
            return Err(resource_conflict(
                "resource_lease_restore_invalid",
                "released resource fact has no matching acquisition",
                &released_resource,
            ));
        };
        if !same_acquisition(existing, &released_resource) {
            return Err(resource_conflict(
                "resource_lease_restore_conflict",
                "released resource metadata does not match its acquisition",
                &released_resource,
            ));
        }
        if existing.state == KernelResourceState::Released {
            if existing == &released_resource {
                return Ok(());
            }
            return Err(resource_conflict(
                "resource_lease_restore_conflict",
                "ledger contains conflicting terminal resource facts",
                &released_resource,
            ));
        }
        *existing = released_resource;
        Ok(())
    }
}

fn same_acquisition(left: &KernelResource, right: &KernelResource) -> bool {
    left.kind == right.kind
        && left.owner == right.owner
        && left.scope == right.scope
        && left.cleanup_policy == right.cleanup_policy
        && left.logical_key == right.logical_key
        && left.idempotency_key == right.idempotency_key
        && left.metadata == right.metadata
}

fn resource_conflict(code: &'static str, message: &str, resource: &KernelResource) -> KernelError {
    KernelError::Structured {
        code,
        stage: "resource.acquire",
        message: message.to_string(),
        details: serde_json::json!({
            "resourceId": resource.resource_id,
            "logicalKey": resource.logical_key,
            "idempotencyKey": resource.idempotency_key,
            "state": resource.state,
        }),
    }
}

fn unix_timestamp_millis() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
