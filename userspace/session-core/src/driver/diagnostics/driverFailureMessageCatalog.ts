export interface DriverDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export class DriverFailureMessageCatalog {
  private readonly contractFailureCodes = new Set([
    'accepted_plan_authorization_contract_incompatible',
  ]);

  private readonly protocolFailureCodes = new Set([
    'agent_protocol_repair_failed',
    'accepted_plan_resource_resume_repair_failed',
    'invalid_json_envelope',
    'invalid_action_bundle',
    'invalid_action_bundle_expectation',
    'invalid_action_bundle_continuation',
    'native_tool_arguments_invalid',
    'session_semantic_directive_invalid',
    'artifact_chunk_invalid',
    'artifact_draft_incomplete',
    'artifact_edit_match_invalid',
    'accepted_task_operation_changed',
    'session_state_contract_unavailable',
    'accepted_task_tool_unavailable',
    'user_authority_input_exceeds_budget',
  ]);

  driverFailure(code: string, message: string): DriverDiagnosticInfo {
    if (code === 'artifact_draft_budget_exceeded') {
      return this.diagnostic(code, `${message}\n\nThe current accepted task must return to Plan and reduce or reorganize its artifact scope before execution can continue.`, { message });
    }
    if (this.contractFailureCodes.has(code)) {
      return this.diagnostic(code, message, { message });
    }
    if (!this.protocolFailureCodes.has(code)) return this.diagnostic('generic', message, { message });
    const fallback = `${message}\n\nThe model output could not form a valid structured proposal (protocol format issue); automatic repair was attempted but unsuccessful. Previously completed steps are not affected. You may retry this turn or rephrase your request.`;
    return this.diagnostic(code, fallback, { message });
  }

  providerFailure(error: unknown): DriverDiagnosticInfo {
    const raw = (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';
    const fallback = `Model call failed: ${raw}\n\nThe connection to the model was interrupted (possibly due to network fluctuation, provider timeout, or response stream closure). Previously completed steps are not affected; please retry this turn.`;
    return this.diagnostic('providerCallFailed', fallback, { raw });
  }

  private diagnostic(code: string, fallback: string, params?: Record<string, string | number>): DriverDiagnosticInfo {
    return { code, fallback, params };
  }
}
