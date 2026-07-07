import type {
  DriverProviderTurnFrame,
  ProviderContextFrame,
  ToolIntentTemplate,
} from '../runFrame.js';
import { stableHash } from '../../cache/canonicalizer.js';

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
  return {
    schemaVersion: contract.schemaVersion,
    contractId: contract.contractId,
    turnMode: contract.turnMode,
    allowedKinds: contract.allowedKinds,
    ...(contract.requiredKind ? { requiredKind: contract.requiredKind } : {}),
    repairPolicy: contract.repairPolicy,
    projectionVisibility: contract.projectionVisibility,
    frames: contract.frames.map((frame) => renderFrame(frame, dynamicContent)),
    toolIntentTemplates: contract.toolIntentTemplates.map(renderToolIntentTemplate),
  };
}

function renderFrame(frame: ProviderContextFrame, dynamicContent: string): Record<string, unknown> {
  const summary = frame.kind === 'NextActionInstruction'
    ? 'See final Provider turn instruction.'
    : frame.summary;
  const rendered: Record<string, unknown> = {
    kind: frame.kind,
    source: frame.source,
    trust: frame.trust,
    ...(frame.scope ? { scope: frame.scope } : {}),
    use: frame.use,
    ...(frame.refs?.length ? { refs: frame.refs } : {}),
    ...(frame.data ? { data: frame.data } : {}),
  };
  if (!summary) return rendered;
  if (summary.length > 16 && dynamicContent.includes(summary)) {
    return {
      ...rendered,
      summaryRef: 'dynamicSuffix',
      summaryHash: stableHash(summary),
      summaryCharLength: summary.length,
    };
  }
  return {
    ...rendered,
    summary,
  };
}

function renderToolIntentTemplate(template: ToolIntentTemplate): Record<string, unknown> {
  return {
    intentId: template.intentId,
    label: template.label,
    operation: template.operation,
    targets: template.targets,
    ...(template.evidencePolicy ? { evidencePolicy: template.evidencePolicy } : {}),
    ...(template.template ? { template: template.template } : {}),
  };
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
