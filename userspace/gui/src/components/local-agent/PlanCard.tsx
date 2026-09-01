import React, { useEffect, useRef, useState } from 'react';
import type { PlanOperation, PlanProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../../deepcode-gui/layout/DeepCodeShellIcon';
import { MarkdownContent } from './BufferedMarkdown';

interface PlanCardProps {
  plan: PlanProjection;
  active: boolean;
  language: UiLanguage;
}

const PlanCard: React.FC<PlanCardProps> = ({
  plan,
  active,
  language,
}) => {
  const previousStatus = useRef(plan.status);
  const [expanded, setExpanded] = useState(() => plan.status === 'published');

  useEffect(() => {
    if (previousStatus.current !== plan.status) {
      if (plan.status === 'confirmed') setExpanded(false);
      if (plan.status === 'published') setExpanded(true);
      previousStatus.current = plan.status;
    }
  }, [plan.status]);

  const status = t(language, `agent.plan.status.${plan.status}`);
  const stepCount = t(language, 'agent.plan.stepCount', { count: plan.steps.length });

  return (
    <article className={`local-agent__plan-card local-agent__plan-card--${plan.status}`}>
      {expanded ? (
        <div className="local-agent__plan-document">
          <button
            type="button"
            className="local-agent__plan-document-meta"
            aria-expanded="true"
            aria-label={t(language, 'agent.plan.collapse')}
            onClick={() => setExpanded(false)}
          >
            <DeepCodeShellIcon name="activity" />
            <span>
              {t(language, 'agent.plan.documentLabel')}
              {' · '}
              {t(language, 'agent.plan.revision', { revision: plan.revision })}
              {active ? ` · ${t(language, 'agent.plan.active')}` : ''}
            </span>
            <DeepCodeShellIcon name="chevronDown" />
          </button>
          <h2>{plan.title}</h2>
          <div className="local-agent__plan-card-overview">
            <MarkdownContent>{plan.summary}</MarkdownContent>
          </div>

          <ol className="local-agent__plan-steps">
            {plan.steps.map((step, index) => (
              <li key={step.stepId}>
                <span className="local-agent__plan-step-marker" aria-hidden="true">{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <div className="local-agent__plan-step-details">
                    <MarkdownContent>{step.details}</MarkdownContent>
                  </div>
                  {step.verification && step.verification.length > 0 && (
                    <div className="local-agent__plan-verification">
                      <span>{t(language, 'agent.plan.verification')}</span>
                      <ul>
                        {step.verification.map((item, index) => (
                          <li key={`${item}:${index}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {plan.mutationManifest.length > 0 && (
            <details className="local-agent__plan-manifest">
              <summary>
                {t(language, 'agent.plan.mutationManifest', {
                  count: plan.mutationManifest.length,
                })}
              </summary>
              <ul>
                {plan.mutationManifest.map((operation, index) => (
                  <li key={`${operation.workspaceId}:${operation.operation}:${planOperationDetail(operation)}:${index}`}>
                    <code>
                      {operation.workspaceId} · {operation.operation} · {planOperationDetail(operation)}
                      {'targetKind' in operation ? ` · ${operation.targetKind}` : ''}
                    </code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="local-agent__plan-card-summary"
          aria-expanded="false"
          aria-label={t(language, 'agent.plan.expand')}
          onClick={() => setExpanded(true)}
        >
          <DeepCodeShellIcon name="activity" />
          <strong>{plan.title}</strong>
          <span className="local-agent__plan-card-status">{status} · {stepCount}</span>
          <span className="local-agent__plan-card-chevron" aria-hidden="true">
            <DeepCodeShellIcon name="chevronRight" />
          </span>
        </button>
      )}
    </article>
  );
};

function planOperationDetail(operation: PlanOperation): string {
  if (operation.operation === 'bash') {
    return `${operation.command} · workspaceMode=${operation.workspaceMode}`;
  }
  return operation.target;
}

export default PlanCard;
