import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { compactDisplayText, sanitizeDisplayText } from './displayText';

interface ToolCallBubbleProps {
  event: AgentEvent;
  language: UiLanguage;
  autoOpen?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? sanitizeDisplayText(value) : undefined;
}

function nestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return isRecord(payload[key]) ? payload[key] as Record<string, unknown> : undefined;
}

function getArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const toolCall = nestedRecord(payload, 'toolCall');
  return (
    nestedRecord(payload, 'arguments') ??
    (toolCall ? nestedRecord(toolCall, 'arguments') : undefined) ??
    nestedRecord(payload, 'input') ??
    nestedRecord(payload, 'argumentsPreview') ??
    nestedRecord(payload, 'output') ??
    payload
  );
}

function getToolName(payload: unknown): string {
  if (!isRecord(payload)) return 'tool';
  const toolCall = nestedRecord(payload, 'toolCall');
  return (
    stringValue(payload.toolName) ??
    stringValue(payload.name) ??
    stringValue(toolCall?.name) ??
    stringValue(payload.actionType) ??
    'tool'
  );
}

function getStatus(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.ok === 'boolean') return payload.ok ? 'ok' : 'error';
  return stringValue(payload.status) ?? stringValue(payload.decision);
}

function getCommand(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const args = getArgs(payload);
  return stringValue(args.command) ?? stringValue(payload.command);
}

function getPath(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const args = getArgs(payload);
  return stringValue(args.path) ?? stringValue(args.cwd) ?? stringValue(payload.path);
}

function getOutputText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const output = nestedRecord(payload, 'output');
  const stdout = stringValue(output?.stdout);
  const stderr = stringValue(output?.stderr);
  const error = stringValue(payload.error);
  const summary = stringValue(payload.summary) ?? stringValue(payload.message);
  return [stdout, stderr, error, summary].filter(Boolean).join('\n').trim() || undefined;
}

function eventLabel(event: AgentEvent, language: UiLanguage): string {
  if (event.kind === 'tool_call') {
    const name = getToolName(event.payload);
    return name.startsWith('shell.')
      ? t(language, 'agent.tool.runCommand')
      : t(language, 'agent.tool.runTool');
  }
  if (event.kind === 'tool_result') return t(language, 'agent.tool.result');
  if (event.kind === 'permission_request') return t(language, 'agent.tool.approvalRequest');
  if (event.kind === 'permission_result') return t(language, 'agent.tool.approvalResult');
  return event.kind;
}

function cardTitle(event: AgentEvent): string {
  const name = getToolName(event.payload);
  const command = getCommand(event.payload);
  const path = getPath(event.payload);
  if (event.kind === 'tool_call' && command) return `${name} · ${command}`;
  if (event.kind === 'permission_request') {
    const summary = isRecord(event.payload) ? stringValue(event.payload.summary) : undefined;
    return summary ?? name;
  }
  if (command) return `${name} · ${command}`;
  if (path) return `${name} · ${path}`;
  return name;
}

function renderDetails(event: AgentEvent, language: UiLanguage) {
  const outputText = getOutputText(event.payload);
  if (event.kind === 'tool_result' && outputText) {
    return (
      <div className="agent-tool-bubble__output">
        <div className="agent-tool-bubble__output-title">
          {t(language, 'agent.tool.output')}
        </div>
        <pre>{sanitizeDisplayText(outputText)}</pre>
      </div>
    );
  }
  if (event.kind === 'permission_request') {
    const risk = isRecord(event.payload) ? stringValue(event.payload.riskLevel) : undefined;
    return (
      <div className="agent-tool-bubble__summary">
        {risk
          ? t(language, 'agent.tool.riskLevel', { risk })
          : t(language, 'agent.tool.waitingApproval')}
      </div>
    );
  }
  if (event.kind === 'permission_result') {
    const decision = isRecord(event.payload) ? stringValue(event.payload.decision) : undefined;
    return (
      <div className="agent-tool-bubble__summary">
        {decision ?? t(language, 'agent.tool.permissionHandled')}
      </div>
    );
  }
  return <div className="agent-tool-bubble__summary">{compactDisplayText(cardTitle(event), 220)}</div>;
}

const ToolCallBubble: React.FC<ToolCallBubbleProps> = ({ event, language, autoOpen = false }) => {
  const status = getStatus(event.payload);
  const title = sanitizeDisplayText(cardTitle(event));

  return (
    <div className={`agent-tool-bubble agent-tool-bubble--${event.kind}`}>
      <details className="agent-tool-bubble__details" open={autoOpen}>
        <summary>
          <span className="agent-tool-bubble__label">{eventLabel(event, language)}</span>
          <span className="agent-tool-bubble__title" title={title}>{compactDisplayText(title, 260)}</span>
          {status && <span className={`agent-tool-bubble__status agent-tool-bubble__status--${status}`}>{status}</span>}
        </summary>
        {renderDetails(event, language)}
        <details className="agent-raw-details">
          <summary>{t(language, 'agent.tool.rawPayload')}</summary>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </details>
      </details>
    </div>
  );
};

export default ToolCallBubble;
