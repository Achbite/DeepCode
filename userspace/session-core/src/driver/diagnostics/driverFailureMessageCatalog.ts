export interface DriverDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export type DriverDiagnosticLanguage = 'zh-CN' | 'en-US';

export class DriverFailureMessageCatalog {
  private readonly contractFailureCodes = new Set([
    'accepted_plan_authorization_contract_incompatible',
  ]);

  private readonly continuationIntegrityFailureCodes = new Set([
    'provider_request_identity_invalid',
    'provider_request_identity_mismatch',
    'provider_thinking_continuation_invalid',
    'session_analysis_timeline_unavailable',
    'session_analysis_timeline_write_failed',
    'session_language_frame_invalid',
    'session_language_policy_unavailable',
    'session_provider_continuation_invalid',
    'session_task_prompt_epoch_incompatible',
    'session_turn_authority_invalid',
    'session_turn_authority_unavailable',
    'session_wire_ledger_unavailable',
    'session_wire_ledger_write_failed',
  ]);

  private readonly protocolFailureCodes = new Set([
    'agent_protocol_repair_failed',
    'accepted_plan_resource_resume_repair_failed',
    'invalid_json_envelope',
    'invalid_action_bundle',
    'invalid_action_bundle_expectation',
    'invalid_action_bundle_continuation',
    'native_tool_arguments_invalid',
    'provider_reserved_token_invalid',
    'provider_continuation_control_leak',
    'session_semantic_directive_invalid',
    'session_language_response_mismatch',
    'artifact_chunk_invalid',
    'artifact_draft_incomplete',
    'artifact_edit_match_invalid',
    'accepted_task_operation_changed',
    'session_state_contract_unavailable',
    'accepted_task_tool_unavailable',
    'user_authority_input_exceeds_budget',
  ]);

  driverFailure(
    code: string,
    _message: string,
    language: DriverDiagnosticLanguage = 'en-US'
  ): DriverDiagnosticInfo {
    const safeCode = publicDiagnosticCode(code);
    if (code === 'artifact_draft_budget_exceeded') {
      const fallback = language === 'zh-CN'
        ? '制品草稿超出当前任务预算。当前已接受任务必须返回 Plan，缩小或重新组织制品范围后才能继续执行。'
        : 'The artifact draft exceeded the current task budget. The accepted task must return to Plan and reduce or reorganize its artifact scope before execution can continue.';
      return this.diagnostic(code, fallback);
    }
    if (this.contractFailureCodes.has(code)) {
      const fallback = language === 'zh-CN'
        ? `当前已接受计划的授权合同与可用执行能力不兼容，Session 已安全停止（错误代码：${code}）。请返回 Plan 调整任务范围或授权要求。`
        : `The accepted plan authorization contract is incompatible with the available execution capabilities, so Session stopped safely (error code: ${code}). Return to Plan and adjust the task scope or authorization requirements.`;
      return this.diagnostic(code, fallback);
    }
    if (this.continuationIntegrityFailureCodes.has(code)) {
      const fallback = language === 'zh-CN'
        ? `Session 在调用模型前发现会话连续性或审计状态不完整，已安全停止（错误代码：${code}）。此前已完成的步骤不受影响；请重试本轮。`
        : `Session detected an incomplete continuation or audit state before the model call and stopped safely (error code: ${code}). Previously completed steps are not affected; retry this turn.`;
      return this.diagnostic(code, fallback);
    }
    if (code === 'llm_empty_response') {
      const fallback = language === 'zh-CN'
        ? '模型未返回可用正文或结构化结果。此前已完成的步骤不受影响；请重试本轮。'
        : 'The model returned no usable answer or structured result. Previously completed steps are not affected; retry this turn.';
      return this.diagnostic(code, fallback);
    }
    if (language === 'zh-CN') {
      const localized = this.localizedDriverFailure(code);
      if (localized) return this.diagnostic(code, localized);
    }
    if (!this.protocolFailureCodes.has(code)) {
      const fallback = language === 'zh-CN'
        ? `Session 执行失败（错误代码：${safeCode}）。此前已完成的步骤不受影响；请重试本轮。`
        : `Session stopped safely before the turn completed (error code: ${safeCode}). Previously completed steps are not affected; retry this turn.`;
      return this.diagnostic(safeCode, fallback);
    }
    const fallback = language === 'zh-CN'
      ? `模型输出未能形成有效的结构化提案，自动修复也未成功（错误代码：${code}）。此前已完成的步骤不受影响；你可以重试本轮或改写请求。`
      : `The model output could not form a valid structured proposal, and automatic repair did not succeed (error code: ${code}). Previously completed steps are not affected. You may retry this turn or rephrase your request.`;
    return this.diagnostic(code, fallback);
  }

  providerFailure(
    _error: unknown,
    language: DriverDiagnosticLanguage = 'en-US'
  ): DriverDiagnosticInfo {
    const fallback = language === 'zh-CN'
      ? '模型调用失败。与模型的连接已中断，可能由网络波动、Provider 超时或响应流关闭导致。此前已完成的步骤不受影响；请重试本轮。'
      : 'Model call failed. The connection to the model was interrupted, possibly due to network fluctuation, Provider timeout, or response stream closure. Previously completed steps are not affected; please retry this turn.';
    return this.diagnostic('providerCallFailed', fallback);
  }

  private diagnostic(code: string, fallback: string, params?: Record<string, string | number>): DriverDiagnosticInfo {
    return { code, fallback, params };
  }

  private localizedDriverFailure(code: string): string | undefined {
    switch (code) {
      case 'requirement_confirmation_failed':
        return '需求确认未能安全建立。此前已完成的步骤不受影响；请重试本轮。';
      case 'decision_resolver_failed':
        return '用户决策未能安全应用。此前已完成的步骤不受影响；请重新提交该决策。';
      case 'run_engine_failed':
        return 'Session 执行循环失败。此前已完成的步骤不受影响；请重试本轮。';
      default:
        return undefined;
    }
  }
}

function publicDiagnosticCode(value: string): string {
  const candidate = value.trim();
  return /^[A-Za-z0-9_.-]{1,96}$/.test(candidate) ? candidate : 'generic';
}
