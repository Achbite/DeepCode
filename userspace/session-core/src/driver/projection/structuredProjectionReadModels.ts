export type ReadableProjectionItemKind =
  | 'text'
  | 'fact'
  | 'target'
  | 'task'
  | 'diagnostic'
  | 'operation'
  | 'permission'
  | 'decision'
  | 'artifact'
  | 'git';

export interface ReadableProjectionItem {
  itemId: string;
  kind: ReadableProjectionItemKind;
  text?: string;
  messageKey?: string;
  messageArgs?: Record<string, string>;
  status?: string;
  targetRefs?: string[];
  auditRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface ReadableProjectionSection {
  sectionId: string;
  titleKey: string;
  titleArgs?: Record<string, string>;
  emptyMessageKey?: string;
  items: ReadableProjectionItem[];
}

export interface ReadablePlanTask {
  taskId: string;
  title: string;
  objective?: string;
  targets: string[];
  acceptance: string[];
  failure: string[];
  status?: string;
  intentKind?: string;
  metadata?: Record<string, unknown>;
}

export interface ReadablePlanProjection {
  schemaVersion: 'deepcode.session.readable-plan.v1';
  titleKey: string;
  summary: string;
  sections: ReadableProjectionSection[];
  tasks: ReadablePlanTask[];
  sourceRefs: Record<string, string>;
}
