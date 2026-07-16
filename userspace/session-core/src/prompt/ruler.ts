import { stableHash } from '../cache/canonicalizer.js';

export type RulerScope = 'global' | 'workspace' | 'project' | 'requirement';

export interface RulerDocument {
  id: string;
  scope: RulerScope;
  version: string;
  sourcePath?: string;
  content: string;
}

export interface RulerConstraint {
  id: string;
  scope: RulerScope;
  priority: number;
  content: string;
  sourcePath?: string;
}

export interface CompiledRuler {
  document: RulerDocument;
  constraints: RulerConstraint[];
  rulerHash: string;
  canGrantPermission: false;
  canOverrideProtocolContract: false;
  canOverrideSystemPrompt: false;
}

export function compileRulerDocument(document: RulerDocument): CompiledRuler {
  const constraints = document.content
    .split(/\n{2,}/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause, index): RulerConstraint => ({
      id: `${document.id}:constraint:${index + 1}`,
      scope: document.scope,
      priority: 100 + index,
      content: clause,
      sourcePath: document.sourcePath,
    }));

  return {
    document,
    constraints,
    rulerHash: stableHash(JSON.stringify({
      id: document.id,
      scope: document.scope,
      version: document.version,
      sourcePath: document.sourcePath ?? '',
      constraints: constraints.map((constraint) => constraint.content),
    })),
    canGrantPermission: false,
    canOverrideProtocolContract: false,
    canOverrideSystemPrompt: false,
  };
}
