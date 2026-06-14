export interface SkillReference {
  id: string;
  name: string;
  path: string;
  scope: 'global' | 'user' | 'workspace';
  enabled: boolean;
  description?: string;
}

export interface SkillReferenceResult {
  skills: SkillReference[];
}
