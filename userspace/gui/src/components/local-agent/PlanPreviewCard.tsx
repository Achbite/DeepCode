import React from 'react';
import type { PlanPreviewProjection } from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import { PlanDocument } from './PlanDocument';

export function PlanPreviewCard({ preview, language }: { preview: PlanPreviewProjection; language: UiLanguage }) {
  const chinese = language === 'zh-CN';
  return <section className="local-agent__plan-document conversation-plan-preview" aria-label={chinese ? '正在生成计划' : 'Generating plan'}>
    <header><span className="local-agent__run-spinner" aria-hidden="true" /><span>{chinese ? '正在生成计划' : 'Generating plan'}</span></header>
    <PlanDocument title={preview.title} summary={preview.summary}
      steps={preview.steps.map((title) => ({ title }))} language={language} streaming />
    <small>{chinese ? '生成完成后统一确认' : 'Confirm once the plan is complete'}{preview.truncated ? (chinese ? ' · 预览已截断' : ' · Preview truncated') : ''}</small>
  </section>;
}
