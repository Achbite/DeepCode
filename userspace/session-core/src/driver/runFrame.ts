import type { ContextAssemblyRecord } from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';

export interface RunFrame {
  readonly sessionId: string;
  readonly runId: string;
}

export type ProviderTurnMode =
  | 'planning'
  | 'requirementDecision'
  | 'acceptedTaskExecution'
  | 'protocolRepair'
  | 'resourceResume'
  | 'scopeIntervention'
  | 'reviewAnswer';

export type ProviderFrameSource =
  | 'system'
  | 'protocol'
  | 'memory'
  | 'user'
  | 'decision'
  | 'session'
  | 'kernel'
  | 'derived'
  | 'error';

export type ProviderFrameTrust =
  | 'contract'
  | 'compressedReference'
  | 'userConfirmedFact'
  | 'kernelObservedFact'
  | 'derivedObservedFact'
  | 'sessionInstruction'
  | 'diagnostic';

export type ProviderRepairPolicy =
  | 'sameKindOnly'
  | 'deterministicIntervention'
  | 'diagnosticOnly';

export type ProviderProjectionVisibility =
  | 'conversation'
  | 'traceOnly'
  | 'developerOnly';

export interface ProviderContextFrame {
  readonly kind: string;
  readonly source: ProviderFrameSource;
  readonly trust: ProviderFrameTrust;
  readonly scope?: string;
  readonly use: string;
  readonly summary?: string;
  readonly refs?: string[];
  readonly data?: unknown;
}

export interface ToolIntentTemplate {
  readonly intentId: string;
  readonly label: string;
  readonly operation: string;
  readonly targets: string[];
  readonly evidencePolicy?: string;
}

export interface ProviderTurnContract {
  readonly schemaVersion: 'deepcode.session.provider-turn-contract.v1';
  readonly contractId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnMode: ProviderTurnMode;
  readonly allowedKinds: string[];
  readonly requiredKind?: string;
  readonly frames: ProviderContextFrame[];
  readonly toolIntentTemplates: ToolIntentTemplate[];
  readonly repairPolicy: ProviderRepairPolicy;
  readonly projectionVisibility: ProviderProjectionVisibility;
  readonly nextActionInstruction: ProviderContextFrame;
  readonly prompt: PromptEnvelope;
  readonly contextAssembly?: ContextAssemblyRecord;
}
