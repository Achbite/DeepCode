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

export interface IgnoredRulerClause {
  id: string;
  reason:
    | 'permission_grant_attempt'
    | 'protocol_contract_override_attempt'
    | 'kernel_boundary_override_attempt'
    | 'empty_clause';
  content: string;
}

export interface CompiledRuler {
  document: RulerDocument;
  constraints: RulerConstraint[];
  ignoredClauses: IgnoredRulerClause[];
  rulerHash: string;
  canGrantPermission: false;
  canOverrideProtocolContract: false;
  canOverrideSystemPrompt: false;
}

export function compileRulerDocument(document: RulerDocument): CompiledRuler {
  const constraints: RulerConstraint[] = [];
  const ignoredClauses: IgnoredRulerClause[] = [];
  const clauses = document.content
    .split(/\n{2,}/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  clauses.forEach((clause, index) => {
    const ignoredReason = classifyIgnoredClause(clause);
    if (ignoredReason) {
      ignoredClauses.push({
        id: `${document.id}:ignored:${index + 1}`,
        reason: ignoredReason,
        content: clause,
      });
      return;
    }
    constraints.push({
      id: `${document.id}:constraint:${index + 1}`,
      scope: document.scope,
      priority: 100 + index,
      content: clause,
      sourcePath: document.sourcePath,
    });
  });

  return {
    document,
    constraints,
    ignoredClauses,
    rulerHash: stableHash(JSON.stringify({
      id: document.id,
      scope: document.scope,
      version: document.version,
      sourcePath: document.sourcePath ?? '',
      constraints: constraints.map((constraint) => constraint.content),
      ignored: ignoredClauses.map((clause) => ({ reason: clause.reason, content: clause.content })),
    })),
    canGrantPermission: false,
    canOverrideProtocolContract: false,
    canOverrideSystemPrompt: false,
  };
}

function classifyIgnoredClause(clause: string): IgnoredRulerClause['reason'] | null {
  const normalized = clause.toLowerCase();
  if (!normalized.trim()) return 'empty_clause';
  if (
    normalized.includes('grant permission') ||
    normalized.includes('skip permission') ||
    (normalized.includes('权限') && (normalized.includes('跳过') || normalized.includes('授权'))) ||
    normalized.includes('不要再问我权限')
  ) {
    return 'permission_grant_attempt';
  }
  if (
    normalized.includes('ignore action_bundle') ||
    normalized.includes('override protocol') ||
    normalized.includes('覆盖 protocol') ||
    normalized.includes('不用 action_bundle')
  ) {
    return 'protocol_contract_override_attempt';
  }
  if (
    normalized.includes('ignore kernel') ||
    normalized.includes('skip reviewgate') ||
    normalized.includes('hardfloor') ||
    normalized.includes('绕过内核')
  ) {
    return 'kernel_boundary_override_attempt';
  }
  return null;
}
