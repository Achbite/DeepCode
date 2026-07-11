import type { LlmResponseFormat, ToolDefinition } from '@deepcode/protocol';
import { canonicalizeToolSchema, stableHash } from '../cache/canonicalizer.js';
import type { DriverProviderTurnFrame, ProviderTurnMode } from '../driver/runFrame.js';

export type SessionProviderProfileId = 'planning-v1' | 'execution-v1' | 'review-v1';

export interface SessionProviderProfile {
  readonly id: SessionProviderProfileId;
  readonly systemContract: string;
  readonly tools: readonly ToolDefinition[];
  readonly responseFormat?: LlmResponseFormat;
  readonly requiredCapabilities: readonly ['functionTools'];
  readonly systemHash: string;
  readonly toolSchemaHash: string;
  readonly responseFormatHash: string;
}

const COMMON_SYSTEM_CONTRACT = [
  'You operate through Session semantic tools.',
  'Use exactly one registered semantic tool when an instruction is needed.',
  'Do not invent Kernel tool identifiers, permission fields, work units, audit fields, or executable transport payloads.',
  'All user-visible prose must follow the language of the current user request.',
  'Tool arguments are directives to Session; Kernel remains the authority for permission, execution, facts, and audit.',
].join('\n');

const PLANNING_TOOLS = Object.freeze([
  semanticTool('session.request_resources', 'Request concrete project facts needed for the next planning decision.', {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'requests'],
    properties: {
      reason: nonEmptyString(),
      requests: {
        type: 'array',
        minItems: 1,
        items: resourceIntentSchema(),
      },
    },
  }),
  semanticTool('session.request_decision', 'Ask the user for one blocking choice that prevents a valid plan or current task directive.', decisionSchema()),
  semanticTool('session.submit_plan', 'Submit an ordered, reviewable task queue. Tasks are not a dependency graph.', planSchema()),
  semanticTool('session.submit_answer', 'Return a final answer when no implementation plan or project operation is required.', answerSchema()),
  semanticTool('session.report_diagnostic', 'Report a terminal diagnostic when the request cannot continue.', diagnosticSchema()),
]);

const EXECUTION_TOOLS = Object.freeze([
  semanticTool('session.request_resources', 'Request concrete facts required for the current accepted task only.', {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'requests'],
    properties: {
      reason: nonEmptyString(),
      requests: {
        type: 'array',
        minItems: 1,
        items: resourceIntentSchema(),
      },
    },
  }),
  semanticTool('session.request_decision', 'Ask the user for one material choice that blocks the current accepted task.', decisionSchema()),
  semanticTool('session.submit_task_artifacts', 'Submit generated content for the current IntentSlot values. Do not submit paths or Kernel tool identifiers.', artifactSchema()),
  semanticTool('session.complete_current_task', 'Mark the current task as already sufficient without creating Kernel change facts.', taskOutcomeSchema()),
  semanticTool('session.report_diagnostic', 'Report a terminal diagnostic for the current accepted task.', diagnosticSchema()),
]);

const REVIEW_TOOLS = Object.freeze([
  semanticTool('session.submit_answer', 'Return a review answer based only on the supplied facts.', answerSchema()),
  semanticTool('session.submit_static_review', 'Return bounded syntax or API observations for the generated files supplied by the current review contract.', staticReviewSchema()),
  semanticTool('session.report_diagnostic', 'Report a review diagnostic without creating execution facts.', diagnosticSchema()),
]);

export class ProviderProfileRegistry {
  private readonly profiles: Record<SessionProviderProfileId, SessionProviderProfile>;

  constructor() {
    this.profiles = {
      'planning-v1': buildProfile('planning-v1', PLANNING_TOOLS),
      'execution-v1': buildProfile('execution-v1', EXECUTION_TOOLS),
      'review-v1': buildProfile('review-v1', REVIEW_TOOLS),
    };
  }

  profileForFrame(frame: DriverProviderTurnFrame | undefined): SessionProviderProfile {
    if (
      frame?.turnMode === 'protocolRepair' &&
      frame.allowedKinds.some((kind) => kind === 'actionBundle' || kind === 'taskOutcome')
    ) {
      return this.profile('execution-v1');
    }
    return this.profile(this.profileIdForMode(frame?.turnMode ?? 'planning'));
  }

  profile(id: SessionProviderProfileId): SessionProviderProfile {
    return this.profiles[id];
  }

  profileIdForMode(mode: ProviderTurnMode): SessionProviderProfileId {
    if (mode === 'acceptedTaskExecution' || mode === 'resourceResume' || mode === 'scopeIntervention') {
      return 'execution-v1';
    }
    if (mode === 'reviewAnswer') return 'review-v1';
    return 'planning-v1';
  }
}

function buildProfile(
  id: SessionProviderProfileId,
  tools: readonly ToolDefinition[]
): SessionProviderProfile {
  const systemContract = `${COMMON_SYSTEM_CONTRACT}\nSession semantic profile: ${id}.`;
  const toolSchemaHash = canonicalizeToolSchema(tools.map((tool) => ({
    name: tool.name,
    schema: tool.inputSchema,
  }))).toolsHash;
  return Object.freeze({
    id,
    systemContract,
    tools,
    requiredCapabilities: ['functionTools'] as const,
    systemHash: stableHash(systemContract),
    toolSchemaHash,
    responseFormatHash: stableHash('provider-native-function-call'),
  });
}

function semanticTool(name: string, description: string, inputSchema: object): ToolDefinition {
  return Object.freeze({
    name,
    description,
    inputSchema,
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'] as ToolDefinition['allowedModes'],
    capability: 'session.directive',
    family: 'provider',
    operationKind: 'sessionDirective',
    permissionMode: 'allow',
    pathScopePolicy: 'sessionValidated',
    executionMode: 'previewOnly',
    readOnly: true,
  });
}

function nonEmptyString(): object {
  return { type: 'string', minLength: 1 };
}

function stringArray(): object {
  return { type: 'array', items: nonEmptyString() };
}

function resourceIntentSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'reason'],
    properties: {
      kind: { type: 'string', enum: ['fileText', 'directoryTree', 'search', 'range'] },
      targetRef: nonEmptyString(),
      path: nonEmptyString(),
      query: nonEmptyString(),
      include: stringArray(),
      offsetBytes: { type: 'integer', minimum: 0 },
      limitBytes: { type: 'integer', minimum: 1 },
      contextLines: { type: 'integer', minimum: 0 },
      maxResults: { type: 'integer', minimum: 1 },
      reason: nonEmptyString(),
    },
  };
}

function decisionSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'options'],
    properties: {
      question: nonEmptyString(),
      summary: nonEmptyString(),
      allowsFreeform: { type: 'boolean' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'label', 'description'],
          properties: {
            id: nonEmptyString(),
            label: nonEmptyString(),
            description: nonEmptyString(),
            recommended: { type: 'boolean' },
          },
        },
      },
    },
  };
}

function planSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'tasks'],
    properties: {
      title: nonEmptyString(),
      summary: nonEmptyString(),
      narration: nonEmptyString(),
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['taskId', 'title', 'operation', 'targets', 'acceptanceCriteria', 'failureCriteria'],
          properties: {
            taskId: nonEmptyString(),
            title: nonEmptyString(),
            operation: {
              type: 'string',
              enum: ['createFile', 'replaceFile', 'patchFile', 'deletePath', 'runProcess', 'inspectResource', 'verifyResult'],
            },
            targets: stringArray(),
            acceptanceCriteria: stringArray(),
            failureCriteria: stringArray(),
          },
        },
      },
      risks: stringArray(),
      reviewCheckpoints: stringArray(),
    },
  };
}

function answerSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: { content: nonEmptyString(), narration: nonEmptyString() },
  };
}

function diagnosticSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['severity', 'summary'],
    properties: {
      severity: { type: 'string', enum: ['info', 'warning', 'error'] },
      summary: nonEmptyString(),
      details: nonEmptyString(),
      narration: nonEmptyString(),
    },
  };
}

function artifactSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'artifacts'],
    properties: {
      summary: nonEmptyString(),
      narration: nonEmptyString(),
      artifacts: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slotId'],
          properties: {
            slotId: nonEmptyString(),
            contentLines: stringArray(),
            matchText: nonEmptyString(),
            replacementLines: stringArray(),
            argv: stringArray(),
            cwd: nonEmptyString(),
            timeoutMs: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  };
}

function taskOutcomeSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: nonEmptyString(),
      evidenceRefs: stringArray(),
      narration: nonEmptyString(),
    },
  };
}

function staticReviewSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'issues'],
    properties: {
      summary: nonEmptyString(),
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['targetRef', 'severity', 'message'],
          properties: {
            targetRef: nonEmptyString(),
            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            message: nonEmptyString(),
            line: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  };
}
