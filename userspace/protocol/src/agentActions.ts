export interface PromptLayer {
  id: string;
  kind: 'builtin' | 'global' | 'user' | 'workspace' | 'session' | 'message';
  path?: string;
  priority: number;
  contentHash: string;
  title?: string;
}

export interface SkillReference {
  id: string;
  name: string;
  path: string;
  scope: 'global' | 'user' | 'workspace';
  enabled: boolean;
  description?: string;
}

export interface PromptLayerResult {
  layers: PromptLayer[];
}

export interface SkillReferenceResult {
  skills: SkillReference[];
}
