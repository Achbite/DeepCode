import type { LlmChatRequest } from '@deepcode/protocol';
import type { CurrentTaskContext } from '../../accepted-plan/index.js';
import type { ContextAssemblyRecord, PromptCachePlan } from '../../context/index.js';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type {
  DriverProviderTurnFrame,
  ModelContextBundle,
  ProviderProjectionVisibility,
  ProviderRepairPolicy,
  ProviderTurnMode,
  SessionDriverProviderRuntimeState,
  ToolIntentTemplate,
} from '../runFrame.js';
import { SessionDriverProviderRuntimeAccessor } from '../runFrame.js';
import { buildProviderTurnSnapshot } from './providerTurnSnapshot.js';
import { renderProviderTurnUserPrompt } from './providerTurnPromptRenderer.js';
import type { ContextFrameBuilder } from './contextFrameBuilder.js';

export interface ProviderSideCallContextAdmissionState extends SessionDriverProviderRuntimeState {
  sessionId: string;
  runId: string;
  userRequest: string;
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
}

export interface ProviderSideCallContextAdmissionInput<State extends ProviderSideCallContextAdmissionState> {
  state: State;
  prompt: PromptEnvelope;
  contextFrameBuilder: ContextFrameBuilder;
  contractId: string;
  turnMode: ProviderTurnMode;
  allowedKinds: string[];
  requiredKind?: string;
  dynamicContent: string;
  userRequest?: string;
  contextAssembly?: ContextAssemblyRecord;
  currentTaskContext?: CurrentTaskContext;
  resourcePackets?: ResourcePacket[];
  generatedArtifactCount?: number;
  toolIntentTemplates?: ToolIntentTemplate[];
  repairPolicy?: ProviderRepairPolicy;
  projectionVisibility?: ProviderProjectionVisibility;
  nextActionInstruction: string;
}

export interface ProviderSideCallMessagesContextAdmissionInput<State extends ProviderSideCallContextAdmissionState>
  extends Omit<ProviderSideCallContextAdmissionInput<State>, 'dynamicContent'> {
  messages: LlmChatRequest['messages'];
}

export interface ProviderSideCallContextAdmissionResult {
  prompt: PromptEnvelope;
  contract: DriverProviderTurnFrame;
  messages: LlmChatRequest['messages'];
  modelContextBundle: ModelContextBundle;
}

export function prepareProviderSideCallContextAdmission<State extends ProviderSideCallContextAdmissionState>(
  input: ProviderSideCallContextAdmissionInput<State>
): ProviderSideCallContextAdmissionResult {
  const prompt = {
    ...input.prompt,
    dynamicSuffix: input.dynamicContent,
  };
  const contract = input.contextFrameBuilder.buildSessionProviderTurnContract({
    contractId: input.contractId,
    sessionId: input.state.sessionId,
    runId: input.state.runId,
    turnMode: input.turnMode,
    allowedKinds: input.allowedKinds,
    requiredKind: input.requiredKind,
    prompt,
    contextAssembly: input.contextAssembly ?? input.state.contextAssembly,
    userRequest: input.userRequest ?? input.state.userRequest,
    acceptedPlanActive: Boolean(input.currentTaskContext),
    currentTaskContext: input.currentTaskContext,
    resourcePackets: input.resourcePackets,
    generatedArtifactCount: input.generatedArtifactCount,
    toolIntentTemplates: input.toolIntentTemplates,
    repairPolicy: input.repairPolicy,
    projectionVisibility: input.projectionVisibility,
    nextActionInstruction: input.nextActionInstruction,
  });
  const snapshot = buildProviderTurnSnapshot(contract);
  const contractWithRuntime = {
    ...contract,
    snapshot,
    hookTrace: [],
  };
  const modelContextBundle = new SessionDriverProviderRuntimeAccessor(input.state).applyModelContext({
    prompt,
    cachePlan: input.state.cachePlan,
    contextAssembly: input.contextAssembly ?? input.state.contextAssembly,
    providerTurnFrame: contractWithRuntime,
    snapshot,
    hookTrace: [],
  });
  return {
    prompt,
    contract: contractWithRuntime,
    messages: [
      { role: 'system', content: prompt.stablePrefix },
      { role: 'user', content: renderProviderTurnUserPrompt(prompt.dynamicSuffix, contractWithRuntime) },
    ],
    modelContextBundle,
  };
}

export function prepareProviderSideCallMessagesContextAdmission<State extends ProviderSideCallContextAdmissionState>(
  input: ProviderSideCallMessagesContextAdmissionInput<State>
): ProviderSideCallContextAdmissionResult {
  const systemContent = input.messages.find((message) => message.role === 'system' && typeof message.content === 'string')?.content
    ?? input.prompt.stablePrefix;
  const dynamicContent = [...input.messages].reverse().find((message) => message.role === 'user' && typeof message.content === 'string')?.content
    ?? input.prompt.dynamicSuffix;
  return prepareProviderSideCallContextAdmission({
    ...input,
    prompt: {
      ...input.prompt,
      stablePrefix: systemContent,
    },
    dynamicContent,
  });
}
