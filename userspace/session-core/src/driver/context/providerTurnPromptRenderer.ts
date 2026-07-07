import type {
  DriverProviderTurnFrame,
  ProviderContextFrame,
  ToolIntentTemplate,
} from '../runFrame.js';

export function renderProviderTurnUserPrompt(dynamicContent: string, contract: DriverProviderTurnFrame): string {
  return [
    dynamicContent,
    'ProviderTurnContract:',
    fencedJson({
      schemaVersion: contract.schemaVersion,
      contractId: contract.contractId,
      turnMode: contract.turnMode,
      allowedKinds: contract.allowedKinds,
      ...(contract.requiredKind ? { requiredKind: contract.requiredKind } : {}),
      repairPolicy: contract.repairPolicy,
      projectionVisibility: contract.projectionVisibility,
      frames: contract.frames.map(renderFrame),
      toolIntentTemplates: contract.toolIntentTemplates.map(renderToolIntentTemplate),
      nextActionInstruction: contract.nextActionInstruction.summary ?? '',
    }),
    [
      'Provider turn instruction:',
      contract.nextActionInstruction.summary ?? '',
    ].join('\n'),
  ].filter((part) => part.trim()).join('\n\n');
}

function renderFrame(frame: ProviderContextFrame): Record<string, unknown> {
  return {
    kind: frame.kind,
    source: frame.source,
    trust: frame.trust,
    ...(frame.scope ? { scope: frame.scope } : {}),
    use: frame.use,
    ...(frame.summary ? { summary: frame.summary } : {}),
    ...(frame.refs?.length ? { refs: frame.refs } : {}),
    ...(frame.data ? { data: frame.data } : {}),
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
