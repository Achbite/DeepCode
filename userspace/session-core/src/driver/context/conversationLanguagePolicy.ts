import type {
  AgentEvent,
  ConversationLanguage,
  ConversationLanguageDecisionSource,
  ConversationLanguagePolicy,
  LlmChatRequest,
  SessionLanguageDecisionPayload,
  SessionTurnAuthorityPayload,
} from '@deepcode/protocol';
import { canonicalJson, stableHash } from '../../cache/canonicalizer.js';

const LANGUAGE_FRAME_OPEN = '<conversation-language>';
const LANGUAGE_FRAME_CLOSE = '</conversation-language>';
const LANGUAGE_AUTHORITY_OPEN = '<conversation-language-authority>';
const LANGUAGE_AUTHORITY_CLOSE = '</conversation-language-authority>';

export interface CreateSessionLanguageDecisionEventInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly status: Exclude<ConversationLanguagePolicy['status'], 'pending'>;
  readonly responseLanguage?: ConversationLanguage;
  readonly decisionSource: ConversationLanguageDecisionSource;
  readonly sourceProviderRequestId?: string;
  readonly sourceToolCallId?: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface ProviderConversationLanguageDecision {
  readonly status: 'resolved' | 'fallback';
  readonly responseLanguage: ConversationLanguage;
  readonly decisionSource:
    | 'modelSemanticDirective'
    | 'hostFallbackMissing'
    | 'hostFallbackInvalid';
  readonly sourceToolCallId?: string;
}

export function normalizeConversationLanguage(value: unknown): ConversationLanguage | undefined {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

export function normalizeHostLanguage(value: unknown): ConversationLanguage {
  return normalizeConversationLanguage(value) ?? 'zh-CN';
}

export function nextConversationLanguageRevision(events: readonly AgentEvent[]): number {
  let revision = 0;
  for (const event of events) {
    const payload = objectRecord(event.payload);
    if (
      event.kind !== 'session_turn_authority'
      && event.kind !== 'session_language_decision'
    ) {
      continue;
    }
    const candidate = positiveInteger(
      event.kind === 'session_turn_authority'
        ? objectRecord(payload?.languagePolicy)?.revision
        : payload?.revision
    );
    if (candidate) revision = Math.max(revision, candidate);
  }
  return revision + 1;
}

export function pendingConversationLanguagePolicy(input: {
  readonly revision: number;
  readonly sourceTurnId: string;
  readonly sourceMessageIds: readonly string[];
  readonly hostLanguage?: ConversationLanguage;
}): ConversationLanguagePolicy {
  return {
    schemaVersion: 'deepcode.session.conversation-language-policy.v1',
    revision: input.revision,
    sourceTurnId: input.sourceTurnId,
    sourceMessageIds: [...input.sourceMessageIds],
    hostLanguage: normalizeHostLanguage(input.hostLanguage),
    status: 'pending',
  };
}

export function createSessionLanguageDecisionEvent(
  input: CreateSessionLanguageDecisionEventInput
): AgentEvent {
  const core: Omit<SessionLanguageDecisionPayload, 'decisionHash'> = {
    schemaVersion: 'deepcode.session.language-decision.v1',
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    revision: input.revision,
    status: input.status,
    responseLanguage: input.responseLanguage,
    decisionSource: input.decisionSource,
    sourceProviderRequestId: input.sourceProviderRequestId,
    sourceToolCallId: input.sourceToolCallId,
  };
  const payload: SessionLanguageDecisionPayload & Record<string, unknown> = {
    ...core,
    decisionHash: stableHash(JSON.stringify(core)),
    channel: 'progress',
    visibility: 'hidden',
    presentation: 'traceOnly',
  };
  return {
    id: input.eventId,
    sessionId: input.sessionId,
    ts: input.timestamp,
    kind: 'session_language_decision',
    payload,
    display: {
      presentation: 'traceOnly',
      importance: 'debug',
    },
  };
}

export function resolveConversationLanguagePolicy(
  events: readonly AgentEvent[],
  authority: SessionTurnAuthorityPayload
): ConversationLanguagePolicy {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'session_language_decision') continue;
    const decision = sessionLanguageDecisionPayload(event.payload);
    if (
      !decision
      || decision.sessionId !== authority.sessionId
      || decision.runId !== authority.runId
      || decision.turnId !== authority.turnId
      || decision.revision !== authority.languagePolicy.revision
    ) {
      continue;
    }
    return {
      ...authority.languagePolicy,
      status: decision.status,
      language: decision.responseLanguage,
      decisionSource: decision.decisionSource,
      sourceProviderRequestId: decision.sourceProviderRequestId,
      sourceToolCallId: decision.sourceToolCallId,
    };
  }
  return authority.languagePolicy;
}

export function effectiveConversationLanguage(
  policy: ConversationLanguagePolicy
): ConversationLanguage {
  return policy.language ?? policy.hostLanguage;
}

export function decideConversationLanguageFromProvider(input: {
  readonly hostLanguage?: ConversationLanguage;
  readonly content: string;
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
}): ProviderConversationLanguageDecision {
  const hostLanguage = normalizeHostLanguage(input.hostLanguage);
  const semanticCall = input.toolCalls.find((call) => call.name.startsWith('session.'));
  if (semanticCall) {
    return providerLanguageValue(
      semanticCall.arguments,
      hostLanguage,
      semanticCall.callId
    );
  }
  const envelope = parseJsonRecord(input.content);
  return providerLanguageValue(envelope, hostLanguage);
}

export function withConversationLanguageFrame(
  messages: LlmChatRequest['messages'],
  policy: ConversationLanguagePolicy,
  authoritativeInput: string
): LlmChatRequest['messages'] {
  const framed = messages.map((message) => (
    message.role === 'user'
      ? {
          ...message,
          content: stripSessionOwnedConversationLanguageControls(message.content),
        }
      : { ...message }
  ));
  const targetIndex = findLastUserMessageIndex(framed);
  if (targetIndex < 0) return framed;
  const authorityMessageIndex = findLastExactUserMessageIndex(framed, authoritativeInput);
  if (authorityMessageIndex < 0) return framed;
  const authority = conversationLanguageAuthority(
    authorityMessageIndex,
    authoritativeInput
  );
  if (policy.status === 'pending') {
    const authorityMessage = framed[authorityMessageIndex]!;
    framed[authorityMessageIndex] = {
      ...authorityMessage,
      content: appendControlSuffix(
        authorityMessage.content,
        conversationLanguageAuthorityMarker(policy, authority)
      ),
    };
  }
  const target = framed[targetIndex]!;
  const frame = conversationLanguageFrame(
    policy,
    conversationLanguageFrameId(framed, targetIndex, target.content, policy, authority),
    authority
  );
  framed[targetIndex] = {
    ...target,
    content: appendControlSuffix(target.content, frame),
  };
  return framed;
}

export function conversationLanguageFrameAdmissionViolation(
  messages: LlmChatRequest['messages'],
  policy: ConversationLanguagePolicy,
  authoritativeInput: string
): string | undefined {
  const frameOpenCount = messages.reduce(
    (count, message) => count + controlTagLineCount(message.content, LANGUAGE_FRAME_OPEN),
    0
  );
  const frameCloseCount = messages.reduce(
    (count, message) => count + controlTagLineCount(message.content, LANGUAGE_FRAME_CLOSE),
    0
  );
  if (frameOpenCount !== 1 || frameCloseCount !== 1) {
    return `expected exactly one complete Session-owned conversation language frame, received ${frameOpenCount} opening and ${frameCloseCount} closing tags`;
  }
  const authorityOpenCount = messages.reduce(
    (count, message) => count + controlTagLineCount(message.content, LANGUAGE_AUTHORITY_OPEN),
    0
  );
  const authorityCloseCount = messages.reduce(
    (count, message) => count + controlTagLineCount(message.content, LANGUAGE_AUTHORITY_CLOSE),
    0
  );
  const expectedAuthorityCount = policy.status === 'pending' ? 1 : 0;
  if (
    authorityOpenCount !== expectedAuthorityCount
    || authorityCloseCount !== expectedAuthorityCount
  ) {
    return `expected ${expectedAuthorityCount} complete authoritative language marker, received ${authorityOpenCount} opening and ${authorityCloseCount} closing tags`;
  }
  const targetIndex = findLastUserMessageIndex(messages);
  if (targetIndex < 0) {
    return 'the Provider request has no user message for the conversation language frame';
  }
  const target = messages[targetIndex]!;
  const terminalFrame = splitTerminalConversationLanguageFrame(target.content);
  if (!terminalFrame) {
    return 'the Session-owned conversation language frame must be the exact terminal suffix of the last Provider user message';
  }
  const unframed = messages.map((message, index) => (
    index === targetIndex
      ? { ...message, content: terminalFrame.baseContent }
      : { ...message }
  ));
  const authority = resolveConversationLanguageAuthority(
    unframed,
    policy,
    authoritativeInput
  );
  if (!authority) {
    return policy.status === 'pending'
      ? 'the Provider request does not contain exactly one marked authoritative user message for the active language revision'
      : 'the Provider request does not contain the complete authoritative user message for the active language revision';
  }
  const expectedFrame = conversationLanguageFrame(
    policy,
    conversationLanguageFrameId(
      unframed,
      targetIndex,
      terminalFrame.baseContent,
      policy,
      authority
    ),
    authority
  );
  if (terminalFrame.frame !== expectedFrame) {
    return 'the conversation language frame does not match the active policy';
  }
  return undefined;
}

export function stripSessionOwnedConversationLanguageControls(content: string): string {
  let stripped = content;
  let changed = true;
  while (changed) {
    changed = false;
    const frame = splitTerminalControlBlock(
      stripped,
      LANGUAGE_FRAME_OPEN,
      LANGUAGE_FRAME_CLOSE
    );
    if (frame && recognizedSessionLanguageFrame(frame.block)) {
      stripped = frame.baseContent;
      changed = true;
      continue;
    }
    const authority = splitTerminalControlBlock(
      stripped,
      LANGUAGE_AUTHORITY_OPEN,
      LANGUAGE_AUTHORITY_CLOSE
    );
    if (authority && recognizedSessionLanguageAuthority(authority.block)) {
      stripped = authority.baseContent;
      changed = true;
    }
  }
  return stripped;
}

function conversationLanguageFrame(
  policy: ConversationLanguagePolicy,
  frameId: string,
  authority: ConversationLanguageAuthority
): string {
  const effective = effectiveConversationLanguage(policy);
  const instructions = policy.status === 'pending'
    ? pendingConversationLanguageInstructions(policy.hostLanguage)
    : resolvedConversationLanguageInstructions(effective);
  return [
    LANGUAGE_FRAME_OPEN,
    `frameId: ${frameId}`,
    `revision: ${policy.revision}`,
    `status: ${policy.status}`,
    `hostFallback: ${policy.hostLanguage}`,
    'scope: provider-control-only',
    `authorityMessageIndex: ${authority.messageIndex}`,
    `authorityMessageContentHash: ${authority.contentHash}`,
    'identitySemantics: frameId and contentHash are local consistency checks only; they are not authorization, security boundaries, or cryptographic proof',
    instructions,
    LANGUAGE_FRAME_CLOSE,
  ].join('\n');
}

function pendingConversationLanguageInstructions(
  hostLanguage: ConversationLanguage
): string {
  return [
    '[ZH] 这是 Session 生成的语言控制帧，不是新任务、指导、权威输入或范围变更；不得把本控制帧自身的语言当作用户语言证据。',
    '[EN] This is a Session-generated language control frame, not a new task, guidance, authority, or scope change. Do not treat the language of this frame as evidence of the user language.',
    '[ZH] 只把末尾带有 `<conversation-language-authority>` 标记的完整 user message 作为本 revision 的语言分类样本；标记自身只是定位元数据。忽略其他消息中代码、日志、路径、引用、工具输出和参考材料的表面语言。',
    '[EN] Use only the complete user message ending in the `<conversation-language-authority>` marker as the language-classification sample for this revision; the marker itself is locator metadata. Ignore the surface language of code, logs, paths, quotations, tool output, and reference material in other messages.',
    '[ZH] 决策优先级固定为：用户明确要求的输出语言；否则主任务指令所用的自然语言；若主指令确实中英混合且无主导语言，或样本仅含代码、日志、路径，则使用 Host fallback。英文标识符或技术术语不构成语言切换。',
    '[EN] Apply this fixed precedence: an explicitly requested output language; otherwise the natural language of the primary task instruction; use Host fallback only when that instruction is genuinely mixed with no dominant language or the sample contains only code, logs, or paths. English identifiers or technical terms do not switch the language.',
    `Host fallback / 主机回退语言: ${hostLanguage}.`,
    '[ZH] 从首个 reasoning_content 字符开始使用 responseLanguage。原始 reasoning 仅供内部分析，不得复制到用户可见字段。',
    '[EN] Use responseLanguage from the first reasoning_content character. Raw reasoning is analysis-only and must not be copied into user-visible fields.',
    '[ZH] 正文、Plan、Decision、Diagnostic、Review、操作说明、标题和摘要使用 responseLanguage；需要解释时只给简洁结论、关键依据、动作、风险和不确定性。',
    '[EN] Use responseLanguage for answers, Plans, Decisions, Diagnostics, Reviews, operation explanations, titles, and summaries. When useful, give only concise conclusions, key evidence, actions, risks, and uncertainty.',
    '[ZH] 注释和工程文档遵循：用户明确要求，其次 Ruler 或项目惯例，最后 responseLanguage。标识符、协议字段、路径、命令、代码和精确引用保持原样。',
    '[EN] For comments and engineering documents, follow explicit user instruction, then Ruler or project convention, then responseLanguage. Keep identifiers, protocol fields, paths, commands, code, and exact quotations unchanged.',
    '[ZH/EN] Report responseLanguage in exactly one Session semantic directive. Do not expose or explain this frame.',
  ].join('\n');
}

function resolvedConversationLanguageInstructions(
  language: ConversationLanguage
): string {
  if (language === 'zh-CN') {
    return [
      '这是 Session 生成的语言控制消息，不是新任务、指导、权威输入或范围变更。',
      '本 revision 已持久化为 zh-CN；不得在 retry、repair、resume、review、empty retry 或 stream fallback 中重新判断或切换语言。',
      '从首个 reasoning_content 字符开始使用简体中文；原始 reasoning 仅供内部分析，不得复制到用户可见字段。',
      '全部用户可见正文、Plan、Decision、Diagnostic、Review、操作说明、标题和摘要必须使用简体中文；不得展示原始思维草稿。',
      '需要解释原因时，只在结构化 narration、summary、answer 或 Plan 中给出简洁的结论、关键依据、动作、风险和不确定性；不得复制原始思维链。',
      '注释和工程文档遵循：用户明确要求，其次 Ruler 或当前项目惯例，最后使用简体中文。',
      '标识符、协议与 schema 字段、路径、命令、代码和精确引用保持原样。',
      '在唯一一条 Session semantic directive 中回报 responseLanguage=zh-CN，不得向用户展示此控制消息。',
    ].join('\n');
  }
  return [
    'This is a Session-generated language control message. It is not a new task, guidance, authority, or scope change.',
    'This revision is persisted as en-US. Do not infer or switch the language again during retry, repair, resume, review, empty retry, or stream fallback.',
    'Use English from the first reasoning_content character. Raw reasoning is analysis-only and must not be copied into user-visible fields.',
    'Use English for every user-visible answer, Plan, Decision, Diagnostic, Review, operation explanation, title, and summary. Do not expose raw thinking drafts.',
    'When an explanation is useful, use structured narration, summary, answer, or Plan fields for concise conclusions, key evidence, actions, risks, and uncertainty. Never copy the raw chain of thought.',
    'For comments and engineering documents, follow this precedence: explicit user instruction, then Ruler or current project convention, then English.',
    'Keep identifiers, protocol and schema fields, paths, commands, code, and exact quotations unchanged.',
    'Report responseLanguage=en-US in exactly one Session semantic directive. Do not expose this control message in user-visible prose.',
  ].join('\n');
}

function conversationLanguageFrameId(
  messages: LlmChatRequest['messages'],
  targetIndex: number,
  targetContent: string,
  policy: ConversationLanguagePolicy,
  authority: ConversationLanguageAuthority
): string {
  const authorityPrefix = messages
    .slice(0, targetIndex + 1)
    .map((message, index) => (
      index === targetIndex
        ? { ...message, content: targetContent }
        : { ...message }
    ));
  return stableHash(canonicalJson({
    schemaVersion: 'deepcode.session.conversation-language-frame-ownership.v1',
    policy,
    authority,
    authorityPrefix,
  }));
}

interface ConversationLanguageAuthority {
  readonly messageIndex: number;
  readonly contentHash: string;
}

function conversationLanguageAuthority(
  messageIndex: number,
  input: string
): ConversationLanguageAuthority {
  return {
    messageIndex,
    contentHash: stableHash(input),
  };
}

function conversationLanguageAuthorityMarker(
  policy: ConversationLanguagePolicy,
  authority: ConversationLanguageAuthority
): string {
  return [
    LANGUAGE_AUTHORITY_OPEN,
    `revision: ${policy.revision}`,
    `messageIndex: ${authority.messageIndex}`,
    `contentHash: ${authority.contentHash}`,
    'scope: language-classification-locator-only',
    LANGUAGE_AUTHORITY_CLOSE,
  ].join('\n');
}

function resolveConversationLanguageAuthority(
  messages: LlmChatRequest['messages'],
  policy: ConversationLanguagePolicy,
  authoritativeInput: string
): ConversationLanguageAuthority | undefined {
  const contentHash = stableHash(authoritativeInput);
  if (policy.status !== 'pending') {
    const messageIndex = findLastExactUserMessageIndex(messages, authoritativeInput);
    return messageIndex < 0
      ? undefined
      : { messageIndex, contentHash };
  }
  const candidates: ConversationLanguageAuthority[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const authority = { messageIndex: index, contentHash };
    const marker = conversationLanguageAuthorityMarker(policy, authority);
    const baseContent = stripExactControlSuffix(message.content, marker);
    if (baseContent === authoritativeInput) candidates.push(authority);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function splitTerminalConversationLanguageFrame(
  content: string
): { baseContent: string; frame: string } | undefined {
  const split = splitTerminalControlBlock(
    content,
    LANGUAGE_FRAME_OPEN,
    LANGUAGE_FRAME_CLOSE
  );
  return split
    ? { baseContent: split.baseContent, frame: split.block }
    : undefined;
}

function splitTerminalControlBlock(
  content: string,
  open: string,
  close: string
): { baseContent: string; block: string } | undefined {
  const blockStart = content.lastIndexOf(open);
  if (blockStart < 0) return undefined;
  const block = content.slice(blockStart);
  if (!block.endsWith(close)) return undefined;
  if (blockStart === 0) {
    return { baseContent: '', block };
  }
  if (content.slice(blockStart - 2, blockStart) !== '\n\n') return undefined;
  return {
    baseContent: content.slice(0, blockStart - 2),
    block,
  };
}

function recognizedSessionLanguageFrame(frame: string): boolean {
  const lines = frame.split('\n');
  const frameIdLine = lines.find((line) => line.startsWith('frameId: '));
  return frame.startsWith(LANGUAGE_FRAME_OPEN)
    && frame.endsWith(LANGUAGE_FRAME_CLOSE)
    && (!frameIdLine || /^frameId: fnv1a32:[0-9a-f]{8}$/u.test(frameIdLine))
    && lines.some((line) => /^revision: [1-9][0-9]*$/u.test(line))
    && lines.some(
      (line) => /^status: (pending|resolved|fallback|superseded)$/u.test(line)
    )
    && lines.some((line) => /^hostFallback: (zh-CN|en-US)$/u.test(line))
    && frame.includes('responseLanguage')
    && (
      frame.includes('Session semantic directive')
      || frame.includes('Session semantic tool')
    );
}

function recognizedSessionLanguageAuthority(authority: string): boolean {
  const lines = authority.split('\n');
  return authority.startsWith(LANGUAGE_AUTHORITY_OPEN)
    && authority.endsWith(LANGUAGE_AUTHORITY_CLOSE)
    && lines.some((line) => /^revision: [1-9][0-9]*$/u.test(line))
    && lines.some((line) => /^messageIndex: (0|[1-9][0-9]*)$/u.test(line))
    && lines.some((line) => /^contentHash: fnv1a32:[0-9a-f]{8}$/u.test(line))
    && lines.includes('scope: language-classification-locator-only');
}

function controlTagLineCount(content: string, tag: string): number {
  return content.split('\n').filter((line) => line === tag).length;
}

function appendControlSuffix(content: string, suffix: string): string {
  return content ? `${content}\n\n${suffix}` : suffix;
}

function stripExactControlSuffix(content: string, suffix: string): string | undefined {
  if (content === suffix) return '';
  const separator = '\n\n';
  return content.endsWith(`${separator}${suffix}`)
    ? content.slice(0, -(separator.length + suffix.length))
    : undefined;
}

function providerLanguageValue(
  record: Record<string, unknown> | undefined,
  hostLanguage: ConversationLanguage,
  sourceToolCallId?: string
): ProviderConversationLanguageDecision {
  const hasDeclaration = Boolean(record && Object.prototype.hasOwnProperty.call(record, 'responseLanguage'));
  const language = normalizeConversationLanguage(record?.responseLanguage);
  if (language) {
    return {
      status: 'resolved',
      responseLanguage: language,
      decisionSource: 'modelSemanticDirective',
      sourceToolCallId,
    };
  }
  return {
    status: 'fallback',
    responseLanguage: hostLanguage,
    decisionSource: hasDeclaration ? 'hostFallbackInvalid' : 'hostFallbackMissing',
    sourceToolCallId,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    return objectRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function findLastUserMessageIndex(messages: LlmChatRequest['messages']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function findLastExactUserMessageIndex(
  messages: LlmChatRequest['messages'],
  content: string
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && message.content === content) return index;
  }
  return -1;
}

function sessionLanguageDecisionPayload(value: unknown): SessionLanguageDecisionPayload | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.language-decision.v1') return undefined;
  const sessionId = stringValue(record.sessionId);
  const runId = stringValue(record.runId);
  const turnId = stringValue(record.turnId);
  const revision = positiveInteger(record.revision);
  const status = record.status === 'resolved'
    || record.status === 'fallback'
    || record.status === 'superseded'
    ? record.status
    : undefined;
  const decisionSource = conversationLanguageDecisionSource(record.decisionSource);
  const decisionHash = stringValue(record.decisionHash);
  if (!sessionId || !runId || !turnId || !revision || !status || !decisionSource || !decisionHash) {
    return undefined;
  }
  const core: Omit<SessionLanguageDecisionPayload, 'decisionHash'> = {
    schemaVersion: 'deepcode.session.language-decision.v1',
    sessionId,
    runId,
    turnId,
    revision,
    status,
    responseLanguage: normalizeConversationLanguage(record.responseLanguage),
    decisionSource,
    sourceProviderRequestId: stringValue(record.sourceProviderRequestId),
    sourceToolCallId: stringValue(record.sourceToolCallId),
  };
  if (stableHash(JSON.stringify(core)) !== decisionHash) return undefined;
  return { ...core, decisionHash };
}

function conversationLanguageDecisionSource(
  value: unknown
): ConversationLanguageDecisionSource | undefined {
  return value === 'modelSemanticDirective'
    || value === 'hostFallbackMissing'
    || value === 'hostFallbackInvalid'
    || value === 'supersededByLaterUserInput'
    ? value
    : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
