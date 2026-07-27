import type { LlmChatResult, LlmChatStreamEvent } from '@deepcode/protocol';
import { stableHash } from '../cache/canonicalizer.js';
import type { AdmittedProviderRequest } from '../driver/pipelines/admittedProviderRequest.js';

export const PROVIDER_ANALYSIS_TIMELINE_SCHEMA_VERSION =
  'deepcode.session.provider-analysis.v1' as const;

export type ProviderAnalysisEventKind =
  | 'provider_request'
  | 'provider_stream'
  | 'provider_response'
  | 'provider_error'
  | 'semantic_exchange';

export interface ProviderAnalysisTimelineEvent {
  readonly schemaVersion: typeof PROVIDER_ANALYSIS_TIMELINE_SCHEMA_VERSION;
  readonly analysisSeq?: number;
  readonly recordId: string;
  readonly previousRecordDigest?: string;
  readonly recordDigest?: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly requestId?: string;
  readonly parentRequestId?: string;
  readonly attemptKind?: string;
  readonly stage: string;
  readonly languageRevision?: number;
  readonly providerSeq?: number;
  readonly providerProfileId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly kind: ProviderAnalysisEventKind;
  readonly completion: 'complete' | 'partial';
  readonly payload: unknown;
  readonly payloadDigest: string;
  readonly createdAt: string;
}

export type ProviderAnalysisSemanticContextRef =
  | {
      readonly promptLedgerEpochId: string;
      readonly providerTurnContractId?: never;
    }
  | {
      readonly promptLedgerEpochId?: never;
      readonly providerTurnContractId: string;
    };

export type ProviderAnalysisSemanticSourceRefsV1 = {
  readonly semantic: {
    readonly analysisRecordId: string;
    readonly providerRequestId: string;
    readonly toolCallId?: string;
    readonly proposalId?: string;
  } & ProviderAnalysisSemanticContextRef;
};

export interface ProviderAnalysisTimelineAppendAck {
  readonly recordId: string;
  readonly analysisSeq: number;
  readonly previousRecordDigest?: string;
  readonly recordDigest: string;
  readonly payloadDigest: string;
  readonly sourcePayloadDigest: string;
}

export type ProviderAnalysisTimelineAppendResult =
  | readonly ProviderAnalysisTimelineAppendAck[]
  | void;

export interface ProviderAnalysisTimelineState {
  readonly sessionId: string;
  readonly runId: string;
  readonly userAuthorityFrame?: {
    readonly turnAuthority: {
      readonly turnId: string;
      readonly taskId?: string;
    };
  };
}

export interface ProviderAnalysisTimelinePorts {
  appendAnalysisTimeline?(
    sessionId: string,
    entries: ProviderAnalysisTimelineEvent[]
  ): Promise<ProviderAnalysisTimelineAppendResult>;
}

export interface ProviderObservedStreamEvent {
  readonly observedAt: string;
  readonly event: LlmChatStreamEvent;
}

export function providerAnalysisTimelineAckViolation(
  entries: readonly ProviderAnalysisTimelineEvent[],
  result: ProviderAnalysisTimelineAppendResult
): string | undefined {
  if (!Array.isArray(result)) {
    return 'analysis timeline storage returned no durable append acknowledgement';
  }
  if (result.length !== entries.length) {
    return `analysis timeline storage acknowledged ${result.length} of ${entries.length} records`;
  }
  let prior: ProviderAnalysisTimelineAppendAck | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const ack = result[index]!;
    if (ack.recordId !== entry.recordId) {
      return `analysis timeline acknowledgement ${index} changed record id ${entry.recordId}`;
    }
    if (!Number.isSafeInteger(ack.analysisSeq) || ack.analysisSeq < 1) {
      return `analysis timeline acknowledgement ${entry.recordId} has an invalid sequence`;
    }
    if (prior && ack.analysisSeq !== prior.analysisSeq + 1) {
      return `analysis timeline acknowledgement ${entry.recordId} is not contiguous`;
    }
    if (
      prior
      && ack.previousRecordDigest !== prior.recordDigest
    ) {
      return `analysis timeline acknowledgement ${entry.recordId} is not linked to its prior digest`;
    }
    if (
      !ack.recordDigest?.trim()
      || !ack.payloadDigest?.trim()
      || !ack.sourcePayloadDigest?.trim()
    ) {
      return `analysis timeline acknowledgement ${entry.recordId} has no durable digest`;
    }
    if (ack.sourcePayloadDigest !== entry.payloadDigest) {
      return `analysis timeline acknowledgement ${entry.recordId} changed its source payload digest`;
    }
    prior = ack;
  }
  return undefined;
}

export function providerRequestAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  admitted: AdmittedProviderRequest;
  recordId: string;
  createdAt: string;
}): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state, input.admitted),
    recordId: input.recordId,
    stage: input.admitted.stage,
    kind: 'provider_request',
    completion: 'complete',
    payload: {
      lifecycle: 'sessionAdmitted',
      exactExternalWireBody: false,
      transportRequest: cloneAnalysisValue(input.admitted.transportRequest),
      providerPayloadDigest: input.admitted.providerPayloadDigest,
      transportDigest: input.admitted.transportDigest,
    },
    createdAt: input.createdAt,
  });
}

export function providerStreamAnalysisEvents(input: {
  state: ProviderAnalysisTimelineState;
  admitted: AdmittedProviderRequest;
  events: readonly ProviderObservedStreamEvent[];
  startProviderSeq: number;
  recordId: string;
  createdAt: string;
  completion: 'complete' | 'partial';
}): ProviderAnalysisTimelineEvent[] {
  return input.events.map((observed, offset) => createProviderAnalysisEvent({
    ...analysisIdentity(input.state, input.admitted),
    recordId: `${input.recordId}-${input.startProviderSeq + offset}`,
    providerSeq: input.startProviderSeq + offset,
    providerProfileId: observed.event.providerProfileId
      ?? input.admitted.transportRequest.profileId,
    provider: observed.event.provider,
    model: observed.event.model,
    stage: input.admitted.stage,
    kind: 'provider_stream',
    completion: offset === input.events.length - 1
      ? input.completion
      : 'partial',
    payload: {
      observedAt: observed.observedAt,
      event: cloneAnalysisValue(observed.event),
    },
    createdAt: input.createdAt,
  }));
}

export function providerResponseAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  admitted: AdmittedProviderRequest;
  result: LlmChatResult;
  disposition?: 'rejectedBeforeSemanticAdmission';
  recordId: string;
  createdAt: string;
}): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state, input.admitted),
    providerProfileId: input.result.providerProfileId
      ?? input.admitted.transportRequest.profileId,
    provider: input.result.provider,
    model: input.result.model,
    recordId: input.recordId,
    stage: input.admitted.stage,
    kind: 'provider_response',
    completion: input.disposition ? 'partial' : 'complete',
    payload: input.disposition
      ? {
          disposition: input.disposition,
          result: cloneAnalysisValue(input.result),
        }
      : cloneAnalysisValue(input.result),
    createdAt: input.createdAt,
  });
}

export function providerErrorAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  admitted: AdmittedProviderRequest;
  error?: string;
  message?: string;
  recordId: string;
  createdAt: string;
}): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state, input.admitted),
    recordId: input.recordId,
    stage: input.admitted.stage,
    kind: 'provider_error',
    completion: 'partial',
    payload: {
      error: input.error,
      message: input.message,
    },
    createdAt: input.createdAt,
  });
}

export function semanticExchangeAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  requestId: string;
  stage: string;
  languageRevision?: number;
  providerProfileId?: string;
  provider?: string;
  model?: string;
  toolCallId: string;
  proposalId?: string;
  toolCall: unknown;
  toolResult: unknown;
  assistantContent: string;
  assistantReasoning: string;
  recordId: string;
  createdAt: string;
} & ProviderAnalysisSemanticContextRef): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state),
    recordId: input.recordId,
    requestId: input.requestId,
    stage: input.stage,
    languageRevision: input.languageRevision,
    providerProfileId: input.providerProfileId,
    provider: input.provider,
    model: input.model,
    kind: 'semantic_exchange',
    completion: 'complete',
    payload: {
      phase: 'completed',
      sourceRefs: semanticSourceRefs(input),
      assistant: {
        content: input.assistantContent,
        reasoningContent: input.assistantReasoning,
      },
      toolCall: cloneAnalysisValue(input.toolCall),
      toolResult: cloneAnalysisValue(input.toolResult),
    },
    createdAt: input.createdAt,
  });
}

export function semanticDirectiveAdmissionAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  requestId: string;
  stage: string;
  languageRevision?: number;
  providerProfileId?: string;
  provider?: string;
  model?: string;
  toolCallId: string;
  toolCall: unknown;
  assistantContent: string;
  assistantReasoning: string;
  recordId: string;
  createdAt: string;
} & ProviderAnalysisSemanticContextRef): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state),
    recordId: input.recordId,
    requestId: input.requestId,
    stage: input.stage,
    languageRevision: input.languageRevision,
    providerProfileId: input.providerProfileId,
    provider: input.provider,
    model: input.model,
    kind: 'semantic_exchange',
    completion: 'partial',
    payload: {
      phase: 'admitted',
      sourceRefs: semanticSourceRefs(input),
      assistant: {
        content: input.assistantContent,
        reasoningContent: input.assistantReasoning,
      },
      toolCall: cloneAnalysisValue(input.toolCall),
    },
    createdAt: input.createdAt,
  });
}

export function semanticDirectiveTerminalAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  requestId: string;
  stage: string;
  languageRevision?: number;
  providerProfileId?: string;
  provider?: string;
  model?: string;
  toolCallId: string;
  proposalId?: string;
  toolCall: unknown;
  assistantContent: string;
  assistantReasoning: string;
  status: 'failed' | 'cancelled' | 'superseded' | 'postEffectPersistenceFailed';
  errorCode?: string;
  errorMessage?: string;
  recordId: string;
  createdAt: string;
} & ProviderAnalysisSemanticContextRef): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state),
    recordId: input.recordId,
    requestId: input.requestId,
    stage: input.stage,
    languageRevision: input.languageRevision,
    providerProfileId: input.providerProfileId,
    provider: input.provider,
    model: input.model,
    kind: 'semantic_exchange',
    completion: 'complete',
    payload: {
      phase: input.status,
      sourceRefs: semanticSourceRefs(input),
      assistant: {
        content: input.assistantContent,
        reasoningContent: input.assistantReasoning,
      },
      toolCall: cloneAnalysisValue(input.toolCall),
      error: {
        code: input.errorCode,
        message: input.errorMessage,
      },
    },
    createdAt: input.createdAt,
  });
}

export function providerSideCallSemanticFailureAnalysisEvent(input: {
  state: ProviderAnalysisTimelineState;
  requestId: string;
  stage: string;
  languageRevision?: number;
  providerProfileId?: string;
  provider?: string;
  model?: string;
  providerTurnContractId: string;
  toolCallId?: string;
  toolCall?: unknown;
  assistantContent: string;
  assistantReasoning: string;
  errorCode?: string;
  errorMessage?: string;
  recordId: string;
  createdAt: string;
}): ProviderAnalysisTimelineEvent {
  return createProviderAnalysisEvent({
    ...analysisIdentity(input.state),
    recordId: input.recordId,
    requestId: input.requestId,
    stage: input.stage,
    languageRevision: input.languageRevision,
    providerProfileId: input.providerProfileId,
    provider: input.provider,
    model: input.model,
    kind: 'semantic_exchange',
    completion: 'complete',
    payload: {
      phase: 'failedBeforeDirectiveAdmission',
      sourceRefs: semanticSourceRefs(input),
      assistant: {
        content: input.assistantContent,
        reasoningContent: input.assistantReasoning,
      },
      ...(input.toolCall === undefined
        ? {}
        : { toolCall: cloneAnalysisValue(input.toolCall) }),
      error: {
        code: input.errorCode,
        message: input.errorMessage,
      },
    },
    createdAt: input.createdAt,
  });
}

function semanticSourceRefs(input: {
  readonly recordId: string;
  readonly requestId: string;
  readonly toolCallId?: string;
  readonly proposalId?: string;
} & ProviderAnalysisSemanticContextRef): ProviderAnalysisSemanticSourceRefsV1 {
  const contextRef = semanticContextRef(input);
  return {
    semantic: {
      analysisRecordId: input.recordId,
      providerRequestId: input.requestId,
      toolCallId: input.toolCallId,
      proposalId: input.proposalId,
      ...contextRef,
    },
  };
}

function semanticContextRef(
  input: ProviderAnalysisSemanticContextRef
): ProviderAnalysisSemanticContextRef {
  const promptLedgerEpochId = input.promptLedgerEpochId?.trim();
  const providerTurnContractId = input.providerTurnContractId?.trim();
  if (Boolean(promptLedgerEpochId) === Boolean(providerTurnContractId)) {
    throw new Error(
      'Provider analysis semantic source must identify exactly one PromptLedger epoch or ProviderTurn contract.'
    );
  }
  return promptLedgerEpochId
    ? { promptLedgerEpochId }
    : { providerTurnContractId: providerTurnContractId! };
}

function createProviderAnalysisEvent(
  input: Omit<ProviderAnalysisTimelineEvent, 'schemaVersion' | 'payloadDigest'>
): ProviderAnalysisTimelineEvent {
  return {
    schemaVersion: PROVIDER_ANALYSIS_TIMELINE_SCHEMA_VERSION,
    ...input,
    payloadDigest: stableHash(stableAnalysisJson(input.payload)),
  };
}

function analysisIdentity(
  state: ProviderAnalysisTimelineState,
  admitted?: AdmittedProviderRequest
): Pick<
  ProviderAnalysisTimelineEvent,
  | 'sessionId'
  | 'runId'
  | 'turnId'
  | 'taskId'
  | 'requestId'
  | 'parentRequestId'
  | 'attemptKind'
  | 'languageRevision'
  | 'providerProfileId'
> {
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    turnId: state.userAuthorityFrame?.turnAuthority.turnId,
    taskId: state.userAuthorityFrame?.turnAuthority.taskId,
    requestId: admitted?.requestId,
    parentRequestId: admitted?.parentRequestId,
    attemptKind: admitted?.attemptKind,
    languageRevision: admitted?.languageRevision,
    providerProfileId: admitted?.transportRequest.profileId,
  };
}

function stableAnalysisJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

function cloneAnalysisValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
