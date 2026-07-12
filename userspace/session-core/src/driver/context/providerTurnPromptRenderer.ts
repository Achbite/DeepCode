import type {
  DriverProviderTurnFrame,
  ToolIntentTemplate,
} from '../runFrame.js';
import { ProviderProfileRegistry } from '../../provider/ProviderProfileRegistry.js';

const profiles = new ProviderProfileRegistry();

export function renderProviderTurnUserPrompt(dynamicContent: string, contract: DriverProviderTurnFrame): string {
  const payload = buildProviderTurnContractPayload(contract, dynamicContent);
  return [
    dynamicContent,
    'ProviderTurnContract:',
    fencedJson(payload),
    [
      'Provider turn instruction:',
      contract.nextActionInstruction.summary ?? '',
    ].join('\n'),
  ].filter((part) => part.trim()).join('\n\n');
}

export function buildProviderTurnContractPayload(
  contract: DriverProviderTurnFrame,
  dynamicContent: string
): Record<string, unknown> {
  const frameRefs = contract.frames.flatMap((frame): Record<string, unknown>[] => {
    if (frame.kind === 'DynamicDialogue') {
      return [{ kind: frame.kind, summaryRef: 'dynamicSuffix' }];
    }
    if (frame.kind === 'NextActionInstruction') {
      return [{ kind: frame.kind, summary: 'See final Provider turn instruction.' }];
    }
    if (frame.kind === 'ConfirmedDecision' || frame.kind === 'ErrorContext') {
      return [{ kind: frame.kind, ...(frame.summary ? { summary: frame.summary } : {}) }];
    }
    if (frame.kind === 'TaskFrame') {
      return [{ kind: frame.kind, ...(frame.data ? { data: frame.data } : {}) }];
    }
    return [];
  });
  return {
    schemaVersion: contract.schemaVersion,
    contractId: contract.contractId,
    semanticProfileId: profiles.profileForFrame(contract).id,
    turnMode: contract.turnMode,
    allowedKinds: contract.allowedKinds,
    ...(contract.requiredKind ? { requiredKind: contract.requiredKind } : {}),
    repairPolicy: contract.repairPolicy,
    projectionVisibility: contract.projectionVisibility,
    frameOrder: contract.frames.map((frame) => frame.kind),
    frameRefs,
    intentSlots: contract.toolIntentTemplates.map(renderToolIntentTemplate),
    dynamicContentIncludedOnce: dynamicContent.length > 0,
  };
}

function renderToolIntentTemplate(template: ToolIntentTemplate): Record<string, unknown> {
  return {
    intentId: template.intentId,
    label: template.label,
    operation: template.operation,
    targets: template.targets,
    ...(template.evidencePolicy ? { evidencePolicy: template.evidencePolicy } : {}),
    ...(template.template ? { slotContract: template.template } : {}),
  };
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
