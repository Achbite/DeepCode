import type { AgentContextAttachment, KernelToolCatalogSnapshot } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../agent-plan/types.js';
import type { PromptEnvelope } from '../prompt/types.js';

export type EntryIntent = 'readOnlyAnswer' | 'resourceDiscovery' | 'developmentTask' | 'repairLoop';

export interface SessionUserTurn {
  sessionId: string;
  parentUuid?: string;
  content: string;
  attachments?: AgentContextAttachment[];
}

export interface KernelStateContractRef {
  runId: string;
  stateId: string;
  stateKind: string;
  allowedInputs: string[];
  allowedProposals: string[];
  proposalSchemaRefs: string[];
  capabilityProjection: string[];
  toolCatalogRef?: string;
  toolCatalogHash?: string;
  toolCatalogSnapshot?: KernelToolCatalogSnapshot;
}

export interface DriverRequestRef {
  id: string;
  runId: string;
  sessionId?: string;
  kind: string;
  reason: string;
  stateContract?: KernelStateContractRef;
}

export interface SessionTurnFrame {
  sessionId: string;
  userTurn: SessionUserTurn;
  entryIntent: EntryIntent;
  driverRequest?: DriverRequestRef;
  stateContract?: KernelStateContractRef;
  promptEnvelope?: PromptEnvelope;
  proposalEnvelope?: ProposalEnvelope;
  projectionFrames: unknown[];
  status: 'created' | 'awaitingKernel' | 'awaitingProvider' | 'awaitingUser' | 'completed' | 'blocked';
}

export interface SessionDriverInput extends SessionUserTurn {
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  repairRequested?: boolean;
  requestedResources?: boolean;
  explicitDevelopmentTask?: boolean;
}
