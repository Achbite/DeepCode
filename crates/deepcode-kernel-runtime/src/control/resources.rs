use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn resource_resolve(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        request: ResourceResolveRequest,
    ) -> KernelResult<Vec<KernelEvent>> {
        let (run_id, session_id) = self.resolve_run_session(Some(run_id), session_id)?;
        let sequence = self.ledger.next_sequence(&run_id)?;
        let workspace_root = self
            .record_by_run(&run_id)?
            .workspace_binding
            .open_path
            .map(PathBuf::from);
        let owner =
            KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string());
        let external_leases = self
            .state
            .resource_manager
            .active_by_owner(&owner)
            .into_iter()
            .filter(|resource| resource.kind == KernelResourceKind::ExternalResourceLease)
            .filter_map(|resource| {
                let KernelResourceMetadata::ExternalResourceLease { lease } = resource.metadata
                else {
                    return None;
                };
                Some((lease.resource_id.clone(), lease))
            })
            .collect();
        let scope = ResourceResolutionScope {
            workspace_root,
            external_leases,
        };
        let packet = resource_packet_from_manifest(&request_id, &request.manifest, &scope);
        self.append_ledger(
            &run_id,
            &session_id,
            "resource.packet_produced",
            sequence,
            serde_json::json!({
                "summary": "Kernel resolved the requested resource packet.",
                "packet": &packet
            }),
        )?;
        Ok(vec![KernelEvent::ResourcePacketProduced {
            request_id: Some(request_id),
            run_id: Some(RunId(run_id)),
            session_id: Some(SessionId(session_id)),
            packet,
            sequence: Some(sequence),
        }])
    }
}
