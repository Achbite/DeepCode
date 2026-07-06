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

  stageSummary(stage: string, phase: 'request' | 'response', language: ProviderStreamVisibleLanguage = 'zh-CN'): string {
    const label = stage
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (value) => value.toUpperCase());
    if (language === 'en-US') {
      return phase === 'request'
        ? `${label}: requesting a structured model response.`
        : `${label}: model response received; parsing protocol output.`;
    }
    return phase === 'request'
      ? `${label}: 请求模型生成结构化回复。`
      : `${label}: 模型已返回，等待协议解析。`;
  }

  nativeToolResolveRunningSummary(toolName: string, language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? `${toolName} is being resolved by Kernel ResourceResolve.`
      : `${toolName} 正在通过 Kernel ResourceResolve 解析。`;
  }

  nativeToolResolveCompletedSummary(toolName: string, language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? `Kernel resolved native tool resource for ${toolName}.`
      : `Kernel 已完成 ${toolName} 的原生工具资源解析。`;
  }

  toolCallPreparingSummary(toolName: string, language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? `Provider is preparing native tool call ${toolName}.`
      : `Provider 正在准备原生工具调用 ${toolName}。`;
  }

  toolCallStreamingSummary(language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? 'Provider is streaming native tool call arguments.'
      : 'Provider 正在流式输出原生工具调用参数。';
  }

  usageSummary(language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? 'Provider usage telemetry received.'
      : '已收到 provider 用量遥测。';
  }

  userGuidanceConsumedSummary(language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? 'User guidance entered the provider resume prompt.'
      : '用户引导已进入 provider resume prompt。';
  }

  guidanceRevisionTransitionMessage(language: ProviderStreamVisibleLanguage): string {
    return language === 'en-US'
      ? 'I received your update and will merge it into the current response before finalizing.'
      : '收到你的补充，我会把这条引导合并到当前回复里重新整理。';
  }
}
