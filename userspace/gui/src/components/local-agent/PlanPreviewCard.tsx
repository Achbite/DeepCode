import React, { useRef, useState } from 'react';
import type { PlanPreviewProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { MarkdownInline } from './BufferedMarkdown';
import { PlanDocument } from './PlanDocument';

interface PlanPreviewCardProps {
  preview: PlanPreviewProjection;
  language: UiLanguage;
  onToggle?: (card: HTMLElement, expanded: boolean) => void;
}

export function PlanPreviewCard({ preview, language, onToggle }: PlanPreviewCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const toggle = () => {
    if (cardRef.current) onToggle?.(cardRef.current, !expanded);
    setExpanded(!expanded);
  };
  const status = language === 'zh-CN' ? '正在生成计划' : 'Generating plan';
  return <section ref={cardRef} className="local-agent__plan-card conversation-plan-preview" aria-label={status}>
    {expanded ? <div className="local-agent__plan-document">
      <button type="button" className="local-agent__plan-document-meta" aria-expanded="true" aria-label={t(language, 'agent.plan.collapse')} onClick={toggle}>
        <span className="local-agent__run-spinner" aria-hidden="true" /><span>{status}</span>
        <DeepCodeShellIcon name="chevronDown" />
      </button>
      <PlanPreviewContent preview={preview} language={language} />
    </div> : <button type="button" className="local-agent__plan-card-summary" aria-expanded="false" aria-label={t(language, 'agent.plan.expand')} onClick={toggle}>
      <span className="local-agent__run-spinner" aria-hidden="true" />
      <strong><MarkdownInline>{preview.title || status}</MarkdownInline></strong>
      <span className="local-agent__plan-card-status">{status}</span>
      <span className="local-agent__plan-card-chevron" aria-hidden="true"><DeepCodeShellIcon name="chevronRight" /></span>
    </button>}
  </section>;
}

export function PlanPreviewContent({ preview, language }: Omit<PlanPreviewCardProps, 'onToggle'>) {
  const chinese = language === 'zh-CN';
  return <>
    <PlanDocument title={preview.title} summary={preview.summary}
      steps={preview.steps.map((title) => ({ title }))} language={language} streaming />
    <small className="conversation-plan-preview-note">{chinese ? '生成完成后统一确认' : 'Confirm once the plan is complete'}{preview.truncated ? (chinese ? ' · 预览已截断' : ' · Preview truncated') : ''}</small>
  </>;
}
