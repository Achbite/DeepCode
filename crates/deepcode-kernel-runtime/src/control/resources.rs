use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn resource_resolve(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
        request: ResourceResolveRequest,
    ) -> KernelResult<Vec<KernelEvent>> {
        let resolved = self.resolve_run_session(run_id, session_id).ok();
        let sequence = resolved
            .as_ref()
            .map(|(run_id, _)| self.ledger.next_sequence(run_id))
            .transpose()?;
        let run_workspace_root = resolved
            .as_ref()
            .and_then(|(run_id, _)| self.record_by_run(run_id).ok())
            .and_then(|record| record.workspace_binding.open_path.map(PathBuf::from));
        let host_workspace_root = resolved
            .is_none()
            .then(|| {
                self.state
                    .current_workspace
                    .as_ref()
                    .map(|workspace| workspace.root.clone())
            })
            .flatten();
        let workspace_root = run_workspace_root.or(host_workspace_root);
        let external_leases = resolved
            .as_ref()
            .map(|(run_id, session_id)| {
                let owner = KernelResourceOwner::agent_run(
                    Some(session_id.to_string()),
                    run_id.to_string(),
                );
                self.state
                    .resource_manager
                    .active_by_owner(&owner)
                    .into_iter()
                    .filter(|resource| resource.kind == KernelResourceKind::ExternalResourceLease)
                    .filter_map(|resource| {
                        serde_json::from_value::<ExternalResourceLease>(resource.metadata)
                            .ok()
                            .map(|lease| (lease.resource_id.clone(), lease))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let scope = ResourceResolutionScope {
            workspace_root,
            external_leases,
        };
        let packet = resource_packet_from_manifest(&request_id, &request.manifest, &scope);
        if let (Some((run_id, session_id)), Some(sequence)) = (resolved.as_ref(), sequence) {
            self.append_ledger(
                run_id,
                session_id,
                "resource.packet_produced",
                sequence,
                serde_json::json!({
                    "summary": "ResourcePacket skeleton produced by Kernel ResourceResolve.",
                    "packet": &packet
                }),
            )?;
        }
        Ok(vec![KernelEvent::ResourcePacketProduced {
            request_id: Some(request_id),
            run_id: resolved.as_ref().map(|(run_id, _)| RunId(run_id.clone())),
            session_id: resolved
                .as_ref()
                .map(|(_, session_id)| SessionId(session_id.clone())),
            packet,
            sequence,
        }])
    }
}
