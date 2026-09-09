import React from 'react';
import type { PlanPreviewProjection } from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import { MarkdownContent } from './BufferedMarkdown';

export function PlanPreviewCard({ preview, language }: { preview: PlanPreviewProjection; language: UiLanguage }) {
  const chinese = language === 'zh-CN';
  return <section className="conversation-plan-preview" aria-label={chinese ? '正在生成计划' : 'Generating plan'}>
    <header><span className="local-agent__run-spinner" aria-hidden="true" /><span>{chinese ? '正在生成计划' : 'Generating plan'}</span></header>
    {preview.title && <strong>{preview.title}</strong>}
    {preview.summary && <MarkdownContent>{preview.summary}</MarkdownContent>}
    {preview.steps.length > 0 && <ol>{preview.steps.map((title, index) => <li key={index}>{title}</li>)}</ol>}
    <small>{chinese ? '生成完成后统一确认' : 'Confirm once the plan is complete'}{preview.truncated ? (chinese ? ' · 预览已截断' : ' · Preview truncated') : ''}</small>
  </section>;
}
