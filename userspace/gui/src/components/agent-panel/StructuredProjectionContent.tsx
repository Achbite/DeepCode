import React from 'react';
import type { AgentTimelineStructuredProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

type StructuredProjectionKind = 'plan' | 'review';

interface StructuredProjectionContentProps {
  projection: AgentTimelineStructuredProjection | undefined;
  language: UiLanguage;
  visibleCharacters?: number;
}

export function StructuredProjectionContent({
  projection,
  language,
  visibleCharacters,
}: StructuredProjectionContentProps) {
  const readable = readableProjection(projection);
  if (!readable) return null;
  const budget = visibleCharacters === undefined ? undefined : { remaining: Math.max(0, visibleCharacters) };
  const summary = visibleText(readableSummary(readable, language), budget);
  const sections = arrayField(readable, 'sections').filter(isRecord);
  return (
    <div className="agent-structured-projection">
      {summary && <div className="agent-flow-card__summary">{summary}</div>}
      {sections.map((section, sectionIndex) => (
        <StructuredProjectionSection
          key={stringField(section, 'sectionId') ?? `section-${sectionIndex}`}
          section={section}
          language={language}
          budget={budget}
        />
      ))}
    </div>
  );
}

export function structuredProjectionText(
  projection: AgentTimelineStructuredProjection | undefined,
  language: UiLanguage
): string {
  const readable = readableProjection(projection);
  if (!readable) return '';
  const title = titleForReadable(readable, language);
  const summary = readableSummary(readable, language);
  const lines = [title ? `# ${title}` : '', summary, ''].filter((line) => line !== undefined);
  for (const section of arrayField(readable, 'sections').filter(isRecord)) {
    const sectionTitle = titleForSection(section, language);
    if (sectionTitle) lines.push(`## ${sectionTitle}`);
    const items = arrayField(section, 'items').filter(isRecord);
    if (items.length) {
      for (const item of items) {
        lines.push(`- ${itemText(item, language)}`);
        for (const detail of itemDetailLines(item, language)) lines.push(`  - ${detail}`);
      }
    } else {
      const emptyKey = stringField(section, 'emptyMessageKey');
      if (emptyKey) lines.push(`- ${t(language, emptyKey)}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function hasStructuredProjection(
  projection: AgentTimelineStructuredProjection | undefined,
  kind?: StructuredProjectionKind
): boolean {
  return Boolean(projection && (!kind || projection.kind === kind) && readableProjection(projection));
}

function StructuredProjectionSection({
  section,
  language,
  budget,
}: {
  section: Record<string, unknown>;
  language: UiLanguage;
  budget?: TextBudget;
}) {
  const title = visibleText(titleForSection(section, language), budget);
  const items = arrayField(section, 'items').filter(isRecord);
  const emptyKey = stringField(section, 'emptyMessageKey');
  const visibleItems = items.flatMap((item, index) => {
    const text = visibleText(itemText(item, language), budget);
    const details = visibleItemDetailLines(item, language, budget);
    return text || details.length > 0
      ? [{ item, index, text, details }]
      : [];
  });
  const emptyText = items.length === 0 && emptyKey ? visibleText(t(language, emptyKey), budget) : '';
  if (!title && visibleItems.length === 0 && !emptyText) return null;
  return (
    <div className="agent-flow-card__section">
      {title && <div className="agent-flow-card__section-title">{title}</div>}
      {visibleItems.length > 0 ? (
        <ul className="agent-flow-card__facts">
          {visibleItems.map(({ item, index, text, details }) => (
            <li key={stringField(item, 'itemId') ?? `item-${index}`}>
              {text && <span>{text}</span>}
              <StructuredProjectionItemDetails details={details} />
            </li>
          ))}
        </ul>
      ) : (
        emptyText && <div className="agent-flow-card__summary">{emptyText}</div>
      )}
    </div>
  );
}

function StructuredProjectionItemDetails({
  details,
}: {
  details: string[];
}) {
  if (!details.length) return null;
  return (
    <ul className="agent-flow-card__facts agent-flow-card__facts--nested">
      {details.map((detail) => <li key={detail}>{detail}</li>)}
    </ul>
  );
}

function readableProjection(
  projection: AgentTimelineStructuredProjection | undefined
): Record<string, unknown> | undefined {
  if (!projection) return undefined;
  if (projection.kind === 'plan' && projection.schemaVersion !== 'deepcode.session.readable-plan.v1') return undefined;
  if (projection.kind === 'review' && projection.schemaVersion !== 'deepcode.session.readable-review.v1') return undefined;
  return projection as unknown as Record<string, unknown>;
}

function readableSummary(readable: Record<string, unknown>, language: UiLanguage): string {
  const summaryKey = stringField(readable, 'summaryKey');
  if (summaryKey) return t(language, summaryKey, recordStringValues(readable.messageArgs));
  return stringField(readable, 'summary') ?? '';
}

function titleForReadable(readable: Record<string, unknown>, language: UiLanguage): string {
  const titleKey = stringField(readable, 'titleKey');
  if (titleKey) return t(language, titleKey, recordStringValues(readable.titleArgs));
  return stringField(readable, 'title') ?? '';
}

function titleForSection(section: Record<string, unknown>, language: UiLanguage): string {
  const titleKey = stringField(section, 'titleKey');
  if (titleKey) return t(language, titleKey, recordStringValues(section.titleArgs));
  return stringField(section, 'title') ?? '';
}

function itemText(item: Record<string, unknown>, language: UiLanguage): string {
  const messageKey = stringField(item, 'messageKey');
  if (messageKey) return t(language, messageKey, recordStringValues(item.messageArgs));
  return stringField(item, 'text') ?? stringField(item, 'summary') ?? '';
}

function itemDetailLines(item: Record<string, unknown>, language: UiLanguage): string[] {
  const details: string[] = [];
  const targetRefs = stringArrayField(item, 'targetRefs');
  if (targetRefs.length) {
    details.push(t(language, 'session.projection.item.targets', { targets: targetRefs.join(', ') }));
  }
  const metadata = isRecord(item.metadata) ? item.metadata : undefined;
  const objective = stringField(metadata, 'objective');
  if (objective) details.push(t(language, 'session.projection.item.objective', { objective }));
  const acceptance = stringArrayField(metadata, 'acceptance');
  if (acceptance.length) {
    details.push(t(language, 'session.projection.item.acceptance', { acceptance: acceptance.join('; ') }));
  }
  const failure = stringArrayField(metadata, 'failure');
  if (failure.length) {
    details.push(t(language, 'session.projection.item.failure', { failure: failure.join('; ') }));
  }
  const auditRefs = stringArrayField(item, 'auditRefs');
  if (auditRefs.length) {
    details.push(t(language, 'session.projection.item.auditRefs', { auditRefs: auditRefs.join(', ') }));
  }
  return details;
}

interface TextBudget {
  remaining: number;
}

function visibleItemDetailLines(
  item: Record<string, unknown>,
  language: UiLanguage,
  budget?: TextBudget
): string[] {
  return itemDetailLines(item, language)
    .map((detail) => visibleText(detail, budget))
    .filter((detail): detail is string => Boolean(detail));
}

function visibleText(text: string, budget?: TextBudget): string {
  if (!budget) return text;
  if (!text || budget.remaining <= 0) return '';
  if (text.length <= budget.remaining) {
    budget.remaining -= text.length;
    return text;
  }
  const visible = text.slice(0, budget.remaining);
  budget.remaining = 0;
  return visible;
}

function recordStringValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) result[key] = String(item);
  }
  return result;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function stringArrayField(value: Record<string, unknown> | undefined, key: string): string[] {
  if (!value) return [];
  const field = value[key];
  if (typeof field === 'string' && field.trim()) return [field.trim()];
  if (!Array.isArray(field)) return [];
  return field.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
