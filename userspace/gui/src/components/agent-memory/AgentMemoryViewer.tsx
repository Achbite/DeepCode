import React, { useEffect, useMemo } from 'react';
import type { AgentEvent, AgentInputAttachmentV2 } from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '@deepcode/session-core';
import { t, type UiLanguage } from '../../i18n';
import './agentMemoryViewer.css';

const PUBLIC_PROJECTION_SCHEMA = 'deepcode.session.kernel-public-projection.v2';
const CONTEXT_RECEIPT_SCHEMA = 'deepcode.session.provider-context-receipt.v2';
const CONTEXT_MEMORY_SCHEMA = 'deepcode.session.context-memory.v2';
const TRIMMING_STRATEGY = 'utf8-bytes-upper-bound.v2';

interface ProviderProfileReceiptV2 {
  providerProfileId: string;
  providerProfileRevisionDigest: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

interface ContextMemoryEntryV2 {
  sourceEventId: string;
  sourceRunId?: string;
  recordedAt: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: AgentInputAttachmentV2[];
}

interface ContextMemoryReceiptV2 {
  schemaVersion: typeof CONTEXT_MEMORY_SCHEMA;
  sessionId: string;
  sourceEventVersion: number;
  sourceEventCount: number;
  omittedEntryCount: number;
  truncated: boolean;
  entries: ContextMemoryEntryV2[];
  contextDigest: string;
}

interface TrimmingSectionReceiptV2 {
  section: string;
  estimatedTokens: number;
  originalCount: number;
  selectedCount: number;
  omittedCount: number;
  digest: string;
}

interface ProviderContextReceiptV2 {
  schemaVersion: typeof CONTEXT_RECEIPT_SCHEMA;
  providerProfile: ProviderProfileReceiptV2;
  inputTokenBudget: number;
  estimatedInputTokens: number;
  memory: ContextMemoryReceiptV2;
  trimming: {
    strategy: typeof TRIMMING_STRATEGY;
    sections: TrimmingSectionReceiptV2[];
  };
}

type LatestReceipt =
  | { status: 'missing' }
  | { status: 'invalid'; eventId: string; recordedAt: string; reason: string }
  | {
      status: 'ready';
      eventId: string;
      recordedAt: string;
      receipt: ProviderContextReceiptV2;
    };

interface AgentMemoryViewerProps {
  language: UiLanguage;
  events: AgentEvent[];
  sessionId?: string | null;
  refreshing?: boolean;
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void;
}

const AgentMemoryViewer: React.FC<AgentMemoryViewerProps> = ({
  language,
  events,
  sessionId,
  refreshing = false,
  onRefresh,
  onClose,
}) => {
  const latest = useMemo(
    () => latestProviderContextReceipt(events, sessionId ?? null),
    [events, sessionId]
  );

  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <section className="agent-memory-viewer" aria-label={t(language, 'memoryV2.title')}>
      <header className="agent-memory-viewer__header">
        <div>
          <h2>{t(language, 'memoryV2.title')}</h2>
          <p>{t(language, 'memoryV2.subtitle')}</p>
        </div>
        <div className="agent-memory-viewer__actions">
          {onRefresh && (
            <button type="button" onClick={() => void onRefresh()} disabled={refreshing}>
              {refreshing
                ? t(language, 'memoryV2.refreshing')
                : t(language, 'memoryV2.refresh')}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose}>
              {t(language, 'memoryV2.close')}
            </button>
          )}
        </div>
      </header>

      {latest.status === 'missing' && (
        <div className="agent-memory-viewer__empty">
          <strong>{t(language, 'memoryV2.notFormed')}</strong>
          <span>{t(language, 'memoryV2.notFormedDetail')}</span>
        </div>
      )}

      {latest.status === 'invalid' && (
        <div className="agent-memory-viewer__invalid" role="alert">
          <strong>{t(language, 'memoryV2.invalid')}</strong>
          <span>{t(language, 'memoryV2.invalidDetail')}</span>
          <code>{latest.reason}</code>
          <small>
            {latest.eventId} · {formatTimestamp(latest.recordedAt, language)}
          </small>
        </div>
      )}

      {latest.status === 'ready' && (
        <ContextReceiptView
          language={language}
          eventId={latest.eventId}
          recordedAt={latest.recordedAt}
          receipt={latest.receipt}
        />
      )}
    </section>
  );
};

function ContextReceiptView({
  language,
  eventId,
  recordedAt,
  receipt,
}: {
  language: UiLanguage;
  eventId: string;
  recordedAt: string;
  receipt: ProviderContextReceiptV2;
}) {
  const { memory, providerProfile } = receipt;
  return (
    <>
      <div className="agent-memory-viewer__receipt-meta">
        <span>{t(language, 'memoryV2.providerProfile')}: {providerProfile.providerProfileId}</span>
        <span>
          {t(language, 'memoryV2.contextWindow')}:
          {' '}{formatNumber(providerProfile.contextWindowTokens, language)}
        </span>
        <span>
          {t(language, 'memoryV2.outputBudget')}:
          {' '}{formatNumber(providerProfile.maxOutputTokens, language)}
        </span>
        <span>
          {t(language, 'memoryV2.inputBudget')}:
          {' '}{formatNumber(receipt.inputTokenBudget, language)}
        </span>
        <span>
          {t(language, 'memoryV2.estimatedInput')}:
          {' '}{formatNumber(receipt.estimatedInputTokens, language)}
        </span>
      </div>

      <dl className="agent-memory-viewer__identity">
        <div>
          <dt>{t(language, 'memoryV2.receiptEvent')}</dt>
          <dd>{eventId}</dd>
        </div>
        <div>
          <dt>{t(language, 'memoryV2.recordedAt')}</dt>
          <dd>{formatTimestamp(recordedAt, language)}</dd>
        </div>
        <div>
          <dt>{t(language, 'memoryV2.profileDigest')}</dt>
          <dd><code>{providerProfile.providerProfileRevisionDigest}</code></dd>
        </div>
        <div>
          <dt>{t(language, 'memoryV2.contextDigest')}</dt>
          <dd><code>{memory.contextDigest}</code></dd>
        </div>
      </dl>

      {(memory.truncated || memory.omittedEntryCount > 0) && (
        <div className="agent-memory-viewer__truncated">
          {t(language, 'memoryV2.truncated', {
            count: formatNumber(memory.omittedEntryCount, language),
          })}
        </div>
      )}

      <section className="agent-memory-viewer__section">
        <header>
          <h3>{t(language, 'memoryV2.injectedMemory')}</h3>
          <span>
            {t(language, 'memoryV2.entrySummary', {
              selected: formatNumber(memory.entries.length, language),
              source: formatNumber(memory.sourceEventCount, language),
            })}
          </span>
        </header>
        {memory.entries.length === 0 ? (
          <div className="agent-memory-viewer__empty agent-memory-viewer__empty--compact">
            {t(language, 'memoryV2.noInjectedEntries')}
          </div>
        ) : (
          <div className="agent-memory-viewer__entries">
            {memory.entries.map((entry) => (
              <article key={entry.sourceEventId} className="agent-memory-entry">
                <div className="agent-memory-entry__meta">
                  <strong>
                    {entry.role === 'user'
                      ? t(language, 'memoryV2.role.user')
                      : t(language, 'memoryV2.role.assistant')}
                  </strong>
                  <span>{formatTimestamp(entry.recordedAt, language)}</span>
                  <span>{entry.sourceEventId}</span>
                  {entry.sourceRunId && <span>Run {entry.sourceRunId}</span>}
                </div>
                <p>{entry.text}</p>
                {entry.attachments.length > 0 && (
                  <div className="agent-memory-entry__attachments">
                    {entry.attachments.map((attachment) => (
                      <span
                        key={`${attachment.scope}:${attachment.folderId ?? ''}:${attachment.path}`}
                        title={attachment.path}
                      >
                        {attachment.kind === 'directory'
                          ? t(language, 'agent.composer.dir')
                          : t(language, 'agent.composer.file')}
                        {' · '}
                        {attachment.path}
                        {' · '}
                        {attachment.scope === 'session'
                          ? t(language, 'agent.attachmentDialog.sessionScope')
                          : t(language, 'agent.attachmentDialog.messageScope')}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="agent-memory-viewer__section">
        <header>
          <h3>{t(language, 'memoryV2.trimmingReceipts')}</h3>
          <code>{receipt.trimming.strategy}</code>
        </header>
        <div className="agent-memory-viewer__sections">
          {receipt.trimming.sections.map((section) => (
            <article key={section.section}>
              <div>
                <strong>{section.section}</strong>
                <code>{section.digest}</code>
              </div>
              <span>
                {t(language, 'memoryV2.sectionCounts', {
                  selected: formatNumber(section.selectedCount, language),
                  original: formatNumber(section.originalCount, language),
                  omitted: formatNumber(section.omittedCount, language),
                  tokens: formatNumber(section.estimatedTokens, language),
                })}
              </span>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function latestProviderContextReceipt(
  events: AgentEvent[],
  expectedSessionId: string | null
): LatestReceipt {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (expectedSessionId && event.sessionId !== expectedSessionId) continue;
    const payload = record(event.payload);
    if (payload?.projectionKind !== 'provider.started') continue;
    const eventId = boundedString(event.id, 1024) ?? 'unknown-event';
    const recordedAt = isoTimestamp(event.ts) ?? '';
    try {
      if (
        payload.schemaVersion !== PUBLIC_PROJECTION_SCHEMA
        || !eventId
        || !recordedAt
      ) {
        throw new Error('public_provider_event_invalid');
      }
      const receipt = parseContextReceipt(
        payload.contextAssembly,
        expectedSessionId ?? event.sessionId
      );
      return { status: 'ready', eventId, recordedAt, receipt };
    } catch (error) {
      return {
        status: 'invalid',
        eventId,
        recordedAt,
        reason: error instanceof Error ? error.message : 'context_receipt_invalid',
      };
    }
  }
  return { status: 'missing' };
}

function parseContextReceipt(
  value: unknown,
  expectedSessionId: string
): ProviderContextReceiptV2 {
  const receipt = exactRecord(value, [
    'schemaVersion',
    'providerProfile',
    'inputTokenBudget',
    'estimatedInputTokens',
    'memory',
    'trimming',
  ]);
  if (receipt.schemaVersion !== CONTEXT_RECEIPT_SCHEMA) {
    throw new Error('context_receipt_schema_invalid');
  }
  const providerProfile = parseProviderProfile(receipt.providerProfile);
  const inputTokenBudget = positiveSafeInteger(
    receipt.inputTokenBudget,
    'context_input_budget_invalid'
  );
  const estimatedInputTokens = nonNegativeSafeInteger(
    receipt.estimatedInputTokens,
    'context_input_estimate_invalid'
  );
  if (
    providerProfile.maxOutputTokens >= providerProfile.contextWindowTokens
    || inputTokenBudget
      !== providerProfile.contextWindowTokens - providerProfile.maxOutputTokens
    || estimatedInputTokens > inputTokenBudget
  ) {
    throw new Error('context_budget_inconsistent');
  }
  const memory = parseMemory(receipt.memory, expectedSessionId);
  const trimming = parseTrimming(receipt.trimming);
  return {
    schemaVersion: CONTEXT_RECEIPT_SCHEMA,
    providerProfile,
    inputTokenBudget,
    estimatedInputTokens,
    memory,
    trimming,
  };
}

function parseProviderProfile(value: unknown): ProviderProfileReceiptV2 {
  const profile = exactRecord(value, [
    'providerProfileId',
    'providerProfileRevisionDigest',
    'contextWindowTokens',
    'maxOutputTokens',
  ]);
  const providerProfileId = requiredString(
    profile.providerProfileId,
    512,
    'provider_profile_id_invalid'
  );
  const providerProfileRevisionDigest = digest(
    profile.providerProfileRevisionDigest,
    'provider_profile_digest_invalid'
  );
  const contextWindowTokens = positiveSafeInteger(
    profile.contextWindowTokens,
    'provider_context_window_invalid'
  );
  const maxOutputTokens = positiveSafeInteger(
    profile.maxOutputTokens,
    'provider_output_budget_invalid'
  );
  return {
    providerProfileId,
    providerProfileRevisionDigest,
    contextWindowTokens,
    maxOutputTokens,
  };
}

function parseMemory(value: unknown, expectedSessionId: string): ContextMemoryReceiptV2 {
  const memory = exactRecord(value, [
    'schemaVersion',
    'sessionId',
    'sourceEventVersion',
    'sourceEventCount',
    'omittedEntryCount',
    'truncated',
    'entries',
    'contextDigest',
  ]);
  if (memory.schemaVersion !== CONTEXT_MEMORY_SCHEMA) {
    throw new Error('context_memory_schema_invalid');
  }
  const sessionId = requiredString(memory.sessionId, 1024, 'context_memory_session_invalid');
  if (sessionId !== expectedSessionId) {
    throw new Error('context_memory_session_mismatch');
  }
  const sourceEventVersion = nonNegativeSafeInteger(
    memory.sourceEventVersion,
    'context_memory_event_version_invalid'
  );
  const sourceEventCount = nonNegativeSafeInteger(
    memory.sourceEventCount,
    'context_memory_event_count_invalid'
  );
  const omittedEntryCount = nonNegativeSafeInteger(
    memory.omittedEntryCount,
    'context_memory_omitted_count_invalid'
  );
  if (typeof memory.truncated !== 'boolean') {
    throw new Error('context_memory_truncated_invalid');
  }
  if (!Array.isArray(memory.entries) || memory.entries.length > 512) {
    throw new Error('context_memory_entries_invalid');
  }
  const entries = memory.entries.map(parseMemoryEntry);
  if (
    entries.length + omittedEntryCount !== sourceEventCount
    || sourceEventCount > sourceEventVersion
  ) {
    throw new Error('context_memory_counts_inconsistent');
  }
  const sourceIds = new Set(entries.map((entry) => entry.sourceEventId));
  if (sourceIds.size !== entries.length) {
    throw new Error('context_memory_entry_identity_duplicate');
  }
  const contextDigest = digest(
    memory.contextDigest,
    'context_memory_digest_invalid'
  );
  const withoutDigest = {
    schemaVersion: CONTEXT_MEMORY_SCHEMA as typeof CONTEXT_MEMORY_SCHEMA,
    sessionId,
    sourceEventVersion,
    sourceEventCount,
    omittedEntryCount,
    truncated: memory.truncated,
    entries,
  };
  if (sha256Hash(canonicalJson(withoutDigest)) !== contextDigest) {
    throw new Error('context_memory_digest_mismatch');
  }
  return {
    ...withoutDigest,
    contextDigest,
  };
}

function parseMemoryEntry(value: unknown): ContextMemoryEntryV2 {
  const entry = exactRecord(
    value,
    ['sourceEventId', 'recordedAt', 'role', 'text', 'attachments'],
    ['sourceRunId']
  );
  const role = entry.role;
  if (role !== 'user' && role !== 'assistant') {
    throw new Error('context_memory_entry_role_invalid');
  }
  if (!Array.isArray(entry.attachments) || entry.attachments.length > 32) {
    throw new Error('context_memory_entry_attachments_invalid');
  }
  if (entry.attachments.length !== 0) {
    throw new Error('context_memory_entry_attachments_forbidden');
  }
  return {
    sourceEventId: requiredString(
      entry.sourceEventId,
      1024,
      'context_memory_entry_event_invalid'
    ),
    ...(entry.sourceRunId === undefined
      ? {}
      : {
          sourceRunId: requiredString(
            entry.sourceRunId,
            1024,
            'context_memory_entry_run_invalid'
          ),
        }),
    recordedAt: requiredTimestamp(
      entry.recordedAt,
      'context_memory_entry_timestamp_invalid'
    ),
    role,
    text: requiredText(entry.text, 1_000_000, 'context_memory_entry_text_invalid'),
    attachments: entry.attachments.map(parseAttachment),
  };
}

function parseAttachment(value: unknown): AgentInputAttachmentV2 {
  const attachment = exactRecord(
    value,
    ['kind', 'path', 'scope'],
    ['resourceId', 'folderId']
  );
  if (attachment.kind !== 'file' && attachment.kind !== 'directory') {
    throw new Error('context_memory_attachment_kind_invalid');
  }
  if (attachment.scope !== 'message' && attachment.scope !== 'session') {
    throw new Error('context_memory_attachment_scope_invalid');
  }
  const path = requiredString(
    attachment.path,
    4096,
    'context_memory_attachment_path_invalid'
  );
  if (
    path.startsWith('/')
    || /^[A-Za-z]:/u.test(path)
    || path.includes('\\')
    || path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('context_memory_attachment_path_invalid');
  }
  return {
    kind: attachment.kind,
    path,
    scope: attachment.scope,
    ...(attachment.resourceId === undefined
      ? {}
      : {
          resourceId: requiredString(
            attachment.resourceId,
            512,
            'context_memory_attachment_resource_invalid'
          ),
        }),
    ...(attachment.folderId === undefined
      ? {}
      : {
          folderId: requiredString(
            attachment.folderId,
            512,
            'context_memory_attachment_folder_invalid'
          ),
        }),
  };
}

function parseTrimming(value: unknown): ProviderContextReceiptV2['trimming'] {
  const expectedSections = [
    'kernelFixedPrompt',
    'sessionContract',
    'currentInput',
    'priorSessionMemory',
    'planDecision',
    'providerOutcomes',
    'canonicalFacts',
  ] as const;
  const trimming = exactRecord(value, ['strategy', 'sections']);
  if (trimming.strategy !== TRIMMING_STRATEGY) {
    throw new Error('context_trimming_strategy_invalid');
  }
  if (
    !Array.isArray(trimming.sections)
    || trimming.sections.length !== expectedSections.length
  ) {
    throw new Error('context_trimming_sections_invalid');
  }
  const sections = trimming.sections.map(parseTrimmingSection);
  const names = new Set(sections.map((section) => section.section));
  if (
    names.size !== sections.length
    || expectedSections.some((section) => !names.has(section))
  ) {
    throw new Error('context_trimming_section_duplicate');
  }
  return {
    strategy: TRIMMING_STRATEGY,
    sections,
  };
}

function parseTrimmingSection(value: unknown): TrimmingSectionReceiptV2 {
  const section = exactRecord(value, [
    'section',
    'estimatedTokens',
    'originalCount',
    'selectedCount',
    'omittedCount',
    'digest',
  ]);
  const originalCount = nonNegativeSafeInteger(
    section.originalCount,
    'context_section_original_count_invalid'
  );
  const selectedCount = nonNegativeSafeInteger(
    section.selectedCount,
    'context_section_selected_count_invalid'
  );
  const omittedCount = nonNegativeSafeInteger(
    section.omittedCount,
    'context_section_omitted_count_invalid'
  );
  if (selectedCount > originalCount || selectedCount + omittedCount !== originalCount) {
    throw new Error('context_section_counts_inconsistent');
  }
  const sectionName = requiredString(
    section.section,
    256,
    'context_section_name_invalid'
  );
  if (![
    'kernelFixedPrompt',
    'sessionContract',
    'currentInput',
    'priorSessionMemory',
    'planDecision',
    'providerOutcomes',
    'canonicalFacts',
  ].includes(sectionName)) {
    throw new Error('context_section_name_invalid');
  }
  return {
    section: sectionName,
    estimatedTokens: nonNegativeSafeInteger(
      section.estimatedTokens,
      'context_section_estimate_invalid'
    ),
    originalCount,
    selectedCount,
    omittedCount,
    digest: digest(section.digest, 'context_section_digest_invalid'),
  };
}

function exactRecord(
  value: unknown,
  requiredKeys: string[],
  optionalKeys: string[] = []
): Record<string, unknown> {
  const valueRecord = record(value);
  if (!valueRecord) throw new Error('context_receipt_object_invalid');
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    Object.keys(valueRecord).some((key) => !allowed.has(key))
    || requiredKeys.some((key) => !Object.hasOwn(valueRecord, key))
  ) {
    throw new Error('context_receipt_shape_invalid');
  }
  return valueRecord;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, maxBytes: number, code: string): string {
  const parsed = boundedString(value, maxBytes);
  if (!parsed) throw new Error(code);
  return parsed;
}

function requiredText(value: unknown, maxBytes: number, code: string): string {
  if (
    typeof value !== 'string'
    || !value
    || !value.trim()
    || new TextEncoder().encode(value).byteLength > maxBytes
    || value.includes('\0')
  ) {
    throw new Error(code);
  }
  return value;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > maxBytes
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function requiredTimestamp(value: unknown, code: string): string {
  const parsed = isoTimestamp(value);
  if (!parsed) throw new Error(code);
  return parsed;
}

function isoTimestamp(value: unknown): string | null {
  const text = boundedString(value, 128);
  if (
    !text
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
    || !Number.isFinite(Date.parse(text))
  ) {
    return null;
  }
  return text;
}

function digest(value: unknown, code: string): string {
  const text = boundedString(value, 128);
  if (!text || !/^sha256:[a-f0-9]{64}$/u.test(text)) throw new Error(code);
  return text;
}

function nonNegativeSafeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function positiveSafeInteger(value: unknown, code: string): number {
  const parsed = nonNegativeSafeInteger(value, code);
  if (parsed === 0) throw new Error(code);
  return parsed;
}

function formatNumber(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language).format(value);
}

function formatTimestamp(value: string, language: UiLanguage): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || t(language, 'memoryV2.unknownTime');
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(timestamp);
}

export default AgentMemoryViewer;
