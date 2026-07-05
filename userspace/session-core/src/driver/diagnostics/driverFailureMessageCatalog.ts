export interface DriverDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export class DriverFailureMessageCatalog {
  private readonly protocolFailureCodes = new Set([
    'agent_protocol_repair_failed',
    'accepted_plan_resource_resume_repair_failed',
    'invalid_json_envelope',
    'invalid_action_bundle',
    'invalid_action_bundle_expectation',
    'invalid_action_bundle_continuation',
  ]);

  driverFailure(code: string, message: string): DriverDiagnosticInfo {
    if (!this.protocolFailureCodes.has(code)) return this.diagnostic('generic', message, { message });
    const fallback = `${message}\n\nThe model output could not form a valid structured proposal (protocol format issue); automatic repair was attempted but unsuccessful. Previously completed steps are not affected. You may retry this turn or rephrase your request.`;
    return this.diagnostic('protocolRepairFailed', fallback, { message });
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
