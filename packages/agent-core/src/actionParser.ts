import type {
  AgentActionParseRequest,
  AgentActionParseResult,
  ParsedAgentAction,
  ParsedAgentActionError,
  ParsedAgentActionType,
} from '@deepcode/protocol';
import {
  asString,
  isRecord,
  nextId,
  parseBool,
  parseNumber,
  pathError,
} from './utils.js';

type RawAction = Record<string, unknown> & { type?: unknown };

const ACTION_TYPES = new Set<ParsedAgentActionType>([
  'fs.read',
  'fs.list',
  'code.search',
  'patch.plan',
  'fs.write',
  'fs.diff',
  'shell.propose',
  'shell.exec',
  'final',
]);

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(raw))) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function validateAction(
  type: ParsedAgentActionType,
  payload: Record<string, unknown>
): ParsedAgentActionError[] {
  const errors: ParsedAgentActionError[] = [];

  if (type === 'fs.read' || type === 'fs.list' || type === 'fs.write' || type === 'fs.diff') {
    const err = pathError(asString(payload.path));
    if (err) errors.push(err);
  }

  if (type === 'patch.plan') {
    const err = pathError(asString(payload.path));
    if (err) errors.push(err);
    if (parseNumber(payload.startLine) === undefined || parseNumber(payload.endLine) === undefined) {
      errors.push({
        code: 'missing_range',
        message: 'patch.plan requires startLine and endLine.',
      });
    }
  }

  if (type === 'code.search' && !asString(payload.query)) {
    errors.push({ code: 'missing_query', message: 'code.search requires query.' });
  }

  if ((type === 'shell.propose' || type === 'shell.exec') && !asString(payload.command)) {
    errors.push({ code: 'missing_command', message: `${type} requires command.` });
  }

  if (type === 'fs.write' && !asString(payload.content)) {
    errors.push({ code: 'missing_content', message: 'fs.write requires content.' });
  }

  if (type === 'fs.diff' && !asString(payload.newContent)) {
    errors.push({ code: 'missing_new_content', message: 'fs.diff requires newContent.' });
  }

  return errors;
}

function normalizeRawAction(raw: RawAction): {
  type?: ParsedAgentActionType;
  payload: Record<string, unknown>;
  errors: ParsedAgentActionError[];
} {
  const rawType = asString(raw.type);
  const errors: ParsedAgentActionError[] = [];
  if (!rawType || !ACTION_TYPES.has(rawType as ParsedAgentActionType)) {
    errors.push({
      code: 'unknown_action_type',
      message: `Unsupported action type: ${rawType ?? '(missing)'}`,
    });
    return { payload: {}, errors };
  }

  const type = rawType as ParsedAgentActionType;
  const payload: Record<string, unknown> = { ...raw };
  delete payload.type;
  if (type === 'code.search' && typeof payload.regex !== 'undefined') {
    payload.isRegex = parseBool(payload.regex);
    delete payload.regex;
  }

  return {
    type,
    payload,
    errors: validateAction(type, payload),
  };
}

function makeAction(
  sourceMessageId: string,
  index: number,
  parseSource: ParsedAgentAction['parseSource'],
  raw: RawAction
): ParsedAgentAction {
  const normalized = normalizeRawAction(raw);
  return {
    id: nextId('act', index),
    sourceMessageId,
    type: normalized.type ?? 'final',
    payload: normalized.payload,
    parseSource,
    status: normalized.errors.length > 0 ? 'invalid' : 'parsed',
    errors: normalized.errors.length > 0 ? normalized.errors : undefined,
  };
}

function parseJsonBlocks(
  content: string,
  sourceMessageId: string,
  startIndex: number
): { actions: ParsedAgentAction[]; errors: ParsedAgentActionError[] } {
  const actions: ParsedAgentAction[] = [];
  const errors: ParsedAgentActionError[] = [];
  const blockPattern = /```deepcode-action\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let index = startIndex;

  while ((match = blockPattern.exec(content))) {
    const rawJson = match[1].trim();
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
        errors.push({
          code: 'invalid_action_block',
          message: 'deepcode-action block must contain an actions array.',
        });
        continue;
      }
      for (const rawAction of parsed.actions) {
        index += 1;
        actions.push(
          makeAction(
            sourceMessageId,
            index,
            'jsonBlock',
            isRecord(rawAction) ? rawAction : { type: undefined }
          )
        );
      }
    } catch (err) {
      errors.push({
        code: 'json_parse_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { actions, errors };
}

function parseTagActions(
  content: string,
  sourceMessageId: string,
  startIndex: number
): ParsedAgentAction[] {
  const actions: ParsedAgentAction[] = [];
  let index = startIndex;

  const selfClosingPattern = /<(load|check)\b([^>]*)\/>/g;
  let selfClosing: RegExpExecArray | null;
  while ((selfClosing = selfClosingPattern.exec(content))) {
    const tag = selfClosing[1];
    const attrs = parseAttributes(selfClosing[2]);
    const raw =
      tag === 'load'
        ? { type: 'fs.read', path: attrs.path }
        : {
            type: 'code.search',
            query: attrs.query,
            include: attrs.path ? [attrs.path] : undefined,
            isRegex: parseBool(attrs.regex),
          };
    index += 1;
    actions.push(makeAction(sourceMessageId, index, 'tag', raw));
  }

  const pairedPattern = /<(shell|exec|patch|final)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let paired: RegExpExecArray | null;
  while ((paired = pairedPattern.exec(content))) {
    const tag = paired[1];
    const attrs = parseAttributes(paired[2]);
    const inner = paired[3].trim();
    let raw: RawAction;
    if (tag === 'shell' || tag === 'exec') {
      raw = {
        type: tag === 'exec' ? 'shell.exec' : 'shell.propose',
        command: inner,
        cwd: attrs.cwd,
        risk: attrs.risk,
        reason: attrs.reason,
        timeoutMs: parseNumber(attrs.timeoutMs),
      };
    } else if (tag === 'patch') {
      raw = {
        type: 'patch.plan',
        path: attrs.path,
        startLine: parseNumber(attrs.startLine),
        endLine: parseNumber(attrs.endLine),
        oldTextSha256: attrs.oldTextSha256,
        newText: inner,
      };
    } else {
      raw = { type: 'final', content: inner };
    }
    index += 1;
    actions.push(makeAction(sourceMessageId, index, 'tag', raw));
  }

  return actions;
}

function stripMachineBlocks(content: string): string {
  return content
    .replace(/```deepcode-action\s*[\s\S]*?```/g, '')
    .replace(/<(load|check)\b[^>]*\/>/g, '')
    .replace(/<(shell|exec|patch|final)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .trim();
}

export class AgentActionParser {
  parse(request: AgentActionParseRequest): AgentActionParseResult {
    const sourceMessageId = request.sourceMessageId ?? `msg-${Date.now()}`;
    const content = request.content ?? '';
    const json = parseJsonBlocks(content, sourceMessageId, 0);
    const tags = parseTagActions(content, sourceMessageId, json.actions.length);
    const actions = [...json.actions, ...tags];

    return {
      sourceMessageId,
      actions,
      errors: json.errors,
      naturalText: stripMachineBlocks(content),
    };
  }
}

export function parseAgentActions(request: AgentActionParseRequest): AgentActionParseResult {
  return new AgentActionParser().parse(request);
}
