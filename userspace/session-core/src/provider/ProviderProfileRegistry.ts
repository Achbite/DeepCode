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
  'This system contract is written in English.',
  'You operate through Session semantic tools.',
  'Use exactly one registered semantic tool when an instruction is needed.',
  'During planning, use Kernel tool identifiers exactly as listed in the current tool catalog. Never invent a toolId or guess whether a tool is executable.',
  'During accepted-task execution, use only the current Session IntentSlot directives and do not resubmit Kernel tool identifiers.',
  'Never invent permission fields, work units, audit fields, or executable transport payloads.',
  'Obey the dynamic conversation-language frame attached to the current authoritative user message.',
  'Every Session semantic directive must report the selected zh-CN or en-US value in responseLanguage.',
  'Do not put private chain-of-thought or scratchpad deliberation into user-visible fields. Answers, plans, decisions, diagnostics, titles, and summaries must be concise, outcome-focused, and may include only a brief evidence-based rationale when it helps the user.',
  'Tool identifiers, schema field names, code identifiers, and protocol literals remain unchanged English tokens.',
  'Tool arguments are directives to Session; Kernel remains the authority for permission, execution, facts, and audit.',
  'ProjectBootstrapSnapshot is navigation metadata only: it identifies the bound root and a bounded first-level inventory, but it never proves file content.',
  'Use session.request_resources with rootId and a root-relative path to read a file or range, inspect a subdirectory, or search text. Never guess absolute paths, file content, existence, or tool availability.',
  'A Session tool result contains only the newly resolved ResourceDelta for that call. Reuse prior results already present in this conversation instead of requesting the same evidence again.',
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
  semanticTool('session.submit_plan', 'Submit an ordered, reviewable task queue with explicit dependencies on earlier tasks.', planSchema()),
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
  semanticTool('session.submit_task_outcome', 'Mark the current accepted task as already satisfied only when fresh task-scoped evidence proves every acceptance criterion. This records a Session outcome, not a Kernel execution fact.', taskOutcomeSchema()),
  semanticTool('session.append_artifact_chunk', 'Append one logically coherent content block to one current IntentSlot. A small file may use one call; larger content may be split by class, function, or configuration section. Session owns draft identity, ordering, hashes, and total-budget admission.', artifactChunkSchema()),
  semanticTool('session.finalize_task_artifacts', 'Finalize the current artifact draft after every current IntentSlot has a final chunk.', artifactFinalizeSchema()),
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
      frame.allowedKinds.some((kind) => kind === 'actionBundle')
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
  const schema = inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  const admittedInputSchema = {
    ...schema,
    required: [...new Set([...(schema.required ?? []), 'responseLanguage'])],
    properties: {
      ...(schema.properties ?? {}),
      responseLanguage: {
        type: 'string',
        enum: ['zh-CN', 'en-US'],
        description: 'Language selected from the dynamic conversation-language frame.',
      },
    },
  };
  return Object.freeze({
    name,
    description,
    inputSchema: admittedInputSchema,
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
      rootId: nonEmptyString(),
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
          required: ['taskId', 'title', 'toolId', 'target', 'dependencies', 'args', 'acceptanceCriteria', 'failureCriteria'],
          properties: {
            taskId: nonEmptyString(),
            title: nonEmptyString(),
            toolId: nonEmptyString(),
            target: stringArray(),
            dependencies: stringArray(),
            args: { type: 'object' },
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

function artifactChunkSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['slotId', 'contentLines', 'finalChunk'],
    properties: {
      slotId: nonEmptyString(),
      contentLines: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
      },
      finalChunk: { type: 'boolean' },
      editMatch: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['exactBlock', 'contextBlock', 'lineRange'] },
          targetLines: stringLinesSchema(),
          beforeLines: stringLinesSchema(),
          afterLines: stringLinesSchema(),
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          expectedFileHash: nonEmptyString(),
          expectedBeforeLines: stringLinesSchema(),
        },
      },
    },
  };
}

function taskOutcomeSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'summary', 'evidenceRefs', 'acceptanceResults'],
    properties: {
      outcome: { type: 'string', enum: ['alreadySatisfied'] },
      summary: nonEmptyString(),
      evidenceRefs: {
        type: 'array',
        minItems: 1,
        items: nonEmptyString(),
      },
      acceptanceResults: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterionIndex', 'status', 'evidenceRefs'],
          properties: {
            criterionIndex: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['satisfied'] },
            evidenceRefs: {
              type: 'array',
              minItems: 1,
              items: nonEmptyString(),
            },
          },
        },
      },
    },
  };
}

function stringLinesSchema(): object {
  return {
    type: 'array',
    items: { type: 'string' },
  };
}

function artifactFinalizeSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      summary: nonEmptyString(),
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
