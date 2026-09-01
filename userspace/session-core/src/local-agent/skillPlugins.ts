import type { RunRuntimeSnapshot } from '@deepcode/protocol';
import type { SessionControlWireNames } from './sessionControls.js';

export type InstructionContribution = RunRuntimeSnapshot['instructions'][number];

export interface RunPluginConfig {
  extensionGenerationRef: string;
  workspaceMutation: 'plan' | 'allow';
  engineeringDecisions: 'ask' | 'delegate';
  selectedPlugins: readonly {
    uri: string;
    displayName: string;
    capabilitySummary: string;
  }[];
}

export function decodeRunPluginConfig(value: unknown): RunPluginConfig {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'extensionGenerationRef',
      'workspaceMutation',
      'engineeringDecisions',
      'selectedPlugins',
    ])
    || !isIdentifier(value.extensionGenerationRef)
    || !['plan', 'allow'].includes(String(value.workspaceMutation))
    || !['ask', 'delegate'].includes(String(value.engineeringDecisions))
    || !Array.isArray(value.selectedPlugins)
    || value.selectedPlugins.length > 16
  ) {
    throw new Error('run_plugin_config_invalid');
  }
  const seen = new Set<string>();
  const selectedPlugins = value.selectedPlugins.map((item) => {
    if (
      !isRecord(item)
      || !hasExactKeys(item, ['uri', 'displayName', 'capabilitySummary'])
      || typeof item.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(item.uri)
      || seen.has(item.uri)
      || typeof item.displayName !== 'string'
      || !item.displayName.trim()
      || item.displayName.length > 160
      || typeof item.capabilitySummary !== 'string'
      || !item.capabilitySummary.trim()
      || new TextEncoder().encode(item.capabilitySummary).byteLength > 4 * 1024
    ) {
      throw new Error('run_selected_plugin_config_invalid');
    }
    seen.add(item.uri);
    return {
      uri: item.uri,
      displayName: item.displayName,
      capabilitySummary: item.capabilitySummary,
    };
  });
  return {
    extensionGenerationRef: value.extensionGenerationRef,
    workspaceMutation: value.workspaceMutation as 'plan' | 'allow',
    engineeringDecisions: value.engineeringDecisions as 'ask' | 'delegate',
    selectedPlugins,
  };
}

export function runtimeInstructions(
  stableCore: readonly InstructionContribution[],
  config: RunPluginConfig,
  controlNames: SessionControlWireNames = {
    interactionRequest: 'interaction_request',
    planPublish: 'plan_publish',
  },
): readonly InstructionContribution[] {
  const workspaceAutonomyInstruction = config.workspaceMutation === 'allow'
    ? `Workspace mutations do not require a Plan. Use ${controlNames.interactionRequest} only for a required user decision.`
    : `Before any workspace mutation, call ${controlNames.planPublish} and wait for confirmation. After confirmation, execute the Plan directly; the Session tracks Todo progress. Use ${controlNames.interactionRequest} only for a required user decision. Call ${controlNames.planPublish} again only when the confirmed Plan must change. Read-only workspace tools do not require a Plan.`;
  const engineeringDecisionInstruction = config.engineeringDecisions === 'delegate'
    ? 'Choose the smallest sound engineering approach supported by workspace evidence.'
    : 'Ask the user before materially changing requirements, public contracts, fact ownership, or the engineering approach.';
  const instructions: InstructionContribution[] = [
    ...stableCore.map((instruction) => ({ ...instruction })),
    {
      id: 'deepcode.workspace-autonomy',
      text: `${workspaceAutonomyInstruction}\n${engineeringDecisionInstruction}`,
    },
    ...config.selectedPlugins.map((plugin) => ({
      id: `plugin.${instructionId(plugin.uri)}`,
      text: `The \`${plugin.displayName}\` plugin is activated for this request by structured user input.

Available capabilities:
${plugin.capabilitySummary}

Use only the listed capabilities for this request. The plugin name is not itself a callable tool.`,
    })),
  ];
  const seen = new Set<string>();
  for (const instruction of instructions) {
    if (!isIdentifier(instruction.id) || !instruction.text.trim() || seen.has(instruction.id)) {
      throw new Error('run_instruction_invalid');
    }
    seen.add(instruction.id);
  }
  return Object.freeze(instructions
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
    .map((instruction) => Object.freeze({ ...instruction })));
}

function instructionId(uri: string): string {
  return uri.replace(/^plugin:\/\//u, '').replace('@', '.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value)
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u.test(value);
}
