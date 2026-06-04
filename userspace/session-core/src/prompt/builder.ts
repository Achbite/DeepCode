import type { PromptEnvelope, PromptEnvelopeBuilderInput, PromptSystemLayer } from './types.js';

export function buildPromptEnvelope(input: PromptEnvelopeBuilderInput): PromptEnvelope {
  const layers = ([
    {
      name: 'baseSystem',
      priority: 0,
      stable: true,
      content: [
        'You are the LLM proposal generator inside DeepCode.',
        'You do not execute tools, modify files, delete files, run shell commands, decide permissions, or decide task completion.',
        'Session parses and organizes your output. Kernel validates permissions, executes actions, records facts, computes diffs, runs validation, writes audit, and controls workflow transition.',
        'Never claim execution, authorization, tests passed, or task completion unless KernelFacts explicitly show it.',
      ].join('\n'),
    },
    {
      name: 'workflowState',
      priority: 1,
      stable: true,
      content: [
        `Current workflow state: ${input.workflowState}.`,
        `Allowed proposals: ${input.allowedProposals.join(', ') || 'none'}.`,
        'If more context is needed, output RESOURCE_REQUEST only.',
        'Do not output RESOURCE_REQUEST and ACTION_BUNDLE in the same turn.',
      ].join('\n'),
    },
    {
      name: 'outputContract',
      priority: 2,
      stable: true,
      content: [
        '<USER_PLAN> human-readable plan </USER_PLAN>',
        '<RESOURCE_REQUEST format="json" version="1"> JSON object </RESOURCE_REQUEST>',
        '<ACTION_BUNDLE format="json" version="1"> JSON object </ACTION_BUNDLE>',
        '<CODE_BLOCK id="..." path="..."> code draft only </CODE_BLOCK>',
        '<EXPECTED_VALIDATION> machine-checkable validation candidates </EXPECTED_VALIDATION>',
        '<REVIEW_GUIDE> human review suggestions only </REVIEW_GUIDE>',
        'Natural language is never executable. Unknown tags and invalid JSON fail closed.',
      ].join('\n'),
    },
    {
      name: 'capabilityProjection',
      priority: 3,
      stable: true,
      content: `Capabilities visible as proposals only, not authorization:\n${input.capabilityCatalogSummary}`,
    },
    {
      name: 'memoryContext',
      priority: 5,
      stable: true,
      content: input.memoryContext?.trim() || 'No stable memory context selected.',
    },
    {
      name: 'userOverlay',
      priority: 6,
      stable: true,
      content: input.userOverlay?.trim() || 'No user overlay prompt selected.',
    },
    {
      name: 'currentRequirement',
      priority: 10,
      stable: false,
      content: [
        `User request: ${input.userRequest}`,
        input.requirement ? `Requirement: ${input.requirement.requirementId} status=${input.requirement.status}` : 'Requirement: not confirmed yet',
      ].join('\n'),
    },
    {
      name: 'resourceContext',
      priority: 11,
      stable: false,
      content: resourceContextSummary(input),
    },
  ] satisfies PromptSystemLayer[]).sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  const stableLayers = layers.filter((layer) => layer.stable);
  const dynamicLayers = layers.filter((layer) => !layer.stable);
  return {
    stablePrefix: stableLayers.map(renderLayer).join('\n\n'),
    dynamicSuffix: dynamicLayers.map(renderLayer).join('\n\n'),
    layers,
    stableLayerNames: stableLayers.map((layer) => layer.name),
    dynamicLayerNames: dynamicLayers.map((layer) => layer.name),
  };
}

function renderLayer(layer: PromptSystemLayer): string {
  return `<${layer.name} priority="${layer.priority}">\n${layer.content}\n</${layer.name}>`;
}

function resourceContextSummary(input: PromptEnvelopeBuilderInput): string {
  const lines: string[] = [];
  if (input.initialContext) {
    lines.push(`InitialContextPacket: ${input.initialContext.id}`);
    lines.push(`ResourceManifest: ${input.initialContext.manifest.id} entries=${input.initialContext.manifest.entries.length}`);
  }
  for (const packet of input.resourcePackets ?? []) {
    lines.push(`ResourcePacket: ${packet.id} request=${packet.requestId} items=${packet.items.length}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'ResourceContext: empty';
}
