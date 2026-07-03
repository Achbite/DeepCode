export type ProviderStreamVisibleLanguage = 'zh-CN' | 'en-US';

const ASSISTANT_DELTA_STAGES = new Set([
  'answer_stream',
  'review_final',
]);

const JSON_PROGRESS_STAGES = new Set([
  'accepted_plan_provider_call',
  'accepted_plan_resource_resume',
  'accepted_plan_resource_resume_repair',
  'accepted_plan_scope_repair',
  'accepted_plan_parent_fallback',
  'accepted_plan_parent_fallback_repair',
]);

export class ProviderStreamCoordinator {
  exposesAssistantDelta(stage: string): boolean {
    return ASSISTANT_DELTA_STAGES.has(stage);
  }

  emitsJsonProgress(stage: string): boolean {
    return JSON_PROGRESS_STAGES.has(stage);
  }

  jsonProgressSummary(language: ProviderStreamVisibleLanguage, receivedChars: number): string {
    return language === 'en-US'
      ? `Generating the executable actionBundle draft (${receivedChars} chars received).`
      : `正在生成可执行 actionBundle 草稿（已接收 ${receivedChars} 字符）。`;
  }
}
