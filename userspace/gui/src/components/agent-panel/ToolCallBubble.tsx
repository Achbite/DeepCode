import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { compactDisplayText, sanitizeDisplayText } from './displayText';
import { cardStatusDefaultOpen, cardStatusGlyph, cardStatusIsSpinning } from './cardStatus';
import { projectToolCard, type ToolCardView } from './cardModel';

interface ToolCallBubbleProps {
  event: AgentEvent;
  language: UiLanguage;
  autoOpen?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function eventLabel(event: AgentEvent, view: ToolCardView, language: UiLanguage): string {
  if (event.kind === 'tool_call') {
    return view.toolName.startsWith('shell.')
      ? t(language, 'agent.tool.runCommand')
      : t(language, 'agent.tool.runTool');
  }
  if (event.kind === 'tool_result') return t(language, 'agent.tool.result');
  if (event.kind === 'permission_request') return t(language, 'agent.tool.approvalRequest');
  if (event.kind === 'permission_result') return t(language, 'agent.tool.approvalResult');
  return event.kind;
}

function cardTitle(event: AgentEvent, view: ToolCardView): string {
  const name = view.toolName;
  if (event.kind === 'tool_call' && view.command) return `${name} · ${view.command}`;
  if (event.kind === 'permission_request') {
    const summary = isRecord(event.payload) && typeof event.payload.summary === 'string' ? event.payload.summary : undefined;
    return summary ?? name;
  }
  if (view.command) return `${name} · ${view.command}`;
  if (view.path) return `${name} · ${view.path}`;
  return name;
}

function renderDetails(event: AgentEvent, view: ToolCardView, language: UiLanguage) {
  if (event.kind === 'tool_result' && view.output) {
    return (
      <div className="agent-tool-bubble__output">
        <div className="agent-tool-bubble__output-title">
          {t(language, 'agent.tool.output')}
        </div>
        <pre>{sanitizeDisplayText(view.output)}</pre>
      </div>
    );
  }
  if (event.kind === 'permission_request') {
    return (
      <div className="agent-tool-bubble__summary">
        {view.riskLevel
          ? t(language, 'agent.tool.riskLevel', { risk: view.riskLevel })
          : t(language, 'agent.tool.waitingApproval')}
      </div>
    );
  }
  if (event.kind === 'permission_result') {
    return (
      <div className="agent-tool-bubble__summary">
        {view.rawStatus ?? t(language, 'agent.tool.permissionHandled')}
      </div>
    );
  }
  return <div className="agent-tool-bubble__summary">{compactDisplayText(cardTitle(event, view), 220)}</div>;
}

const ToolCallBubble: React.FC<ToolCallBubbleProps> = ({ event, language, autoOpen = false }) => {
  const view = projectToolCard(event);
  const spinning = cardStatusIsSpinning(view.status);
  const glyph = cardStatusGlyph(view.status);
  const title = sanitizeDisplayText(cardTitle(event, view));
  const open = autoOpen || cardStatusDefaultOpen(view.status);

  return (
    <div className={`agent-tool-bubble agent-tool-bubble--${event.kind}`}>
      <details className="agent-tool-bubble__details" open={open}>
        <summary>
          <span className="agent-tool-bubble__lead">
            {spinning ? (
              <span className="agent-spinner" />
            ) : (
              glyph && <span className={`agent-status-icon agent-status-icon--${view.status}`}>{glyph}</span>
            )}
            <span className="agent-tool-bubble__label">{eventLabel(event, view, language)}</span>
          </span>
          <span className="agent-tool-bubble__title" title={title}>{compactDisplayText(title, 260)}</span>
          {view.rawStatus && (
            <span className={`agent-tool-bubble__status agent-tool-bubble__status--${view.rawStatus}`}>{view.rawStatus}</span>
          )}
        </summary>
        {renderDetails(event, view, language)}
        {isRecord(event.payload) && (
          <details className="agent-raw-details">
            <summary>{t(language, 'agent.tool.rawPayload')}</summary>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </details>
        )}
      </details>
    </div>
  );
};

export default ToolCallBubble;
