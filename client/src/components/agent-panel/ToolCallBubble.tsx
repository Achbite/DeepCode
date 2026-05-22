import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';

interface ToolCallBubbleProps {
  event: AgentEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getPath(payload: Record<string, unknown>): string | undefined {
  const input = isRecord(payload.input) ? payload.input : undefined;
  const args = isRecord(payload.arguments) ? payload.arguments : undefined;
  return (
    stringValue(payload.path) ??
    stringValue(input?.path) ??
    stringValue(args?.path) ??
    stringValue(input?.cwd) ??
    stringValue(args?.cwd)
  );
}

function getCommand(payload: Record<string, unknown>): string | undefined {
  const input = isRecord(payload.input) ? payload.input : undefined;
  const args = isRecord(payload.arguments) ? payload.arguments : undefined;
  return (
    stringValue(payload.command) ??
    stringValue(input?.command) ??
    stringValue(args?.command)
  );
}

function getToolName(payload: unknown): string {
  if (!isRecord(payload)) return 'tool';
  return (
    stringValue(payload.toolName) ??
    stringValue(payload.name) ??
    stringValue(payload.actionType) ??
    stringValue(payload.callId) ??
    'tool'
  );
}

function getStatus(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.ok === 'boolean') return payload.ok ? 'ok' : 'error';
  return stringValue(payload.status) ?? stringValue(payload.decision);
}

function getSummary(payload: unknown): string {
  if (!isRecord(payload)) {
    return typeof payload === 'string' ? payload : 'No details';
  }
  const command = getCommand(payload);
  if (command) return command;
  const path = getPath(payload);
  if (path) return path;
  const summary = stringValue(payload.summary) ?? stringValue(payload.message);
  if (summary) return summary;
  if (payload.output && typeof payload.output !== 'object') return String(payload.output);
  if (isRecord(payload.output)) {
    const outputSummary = stringValue(payload.output.summary) ?? stringValue(payload.output.message);
    if (outputSummary) return outputSummary;
  }
  return 'Details available';
}

function eventLabel(kind: AgentEvent['kind']): string {
  switch (kind) {
    case 'tool_call':
      return 'Tool call';
    case 'tool_result':
      return 'Tool result';
    case 'permission_request':
      return 'Permission required';
    case 'permission_result':
      return 'Permission result';
    default:
      return kind;
  }
}

const ToolCallBubble: React.FC<ToolCallBubbleProps> = ({ event }) => {
  const toolName = getToolName(event.payload);
  const status = getStatus(event.payload);
  const summary = getSummary(event.payload);

  return (
    <div className={`agent-tool-bubble agent-tool-bubble--${event.kind}`}>
      <div className="agent-tool-bubble__header">
        <span>{eventLabel(event.kind)}</span>
        {status && <span className={`agent-tool-bubble__status agent-tool-bubble__status--${status}`}>{status}</span>}
      </div>
      <div className="agent-tool-bubble__title">{toolName}</div>
      <div className="agent-tool-bubble__summary">{summary}</div>
      <details className="agent-raw-details">
        <summary>Raw payload</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </div>
  );
};

export default ToolCallBubble;
