import type { AgentInputAttachmentV2 } from '@deepcode/protocol';

const MAX_AGENT_INPUT_ATTACHMENTS_V2 = 32;
const MAX_AGENT_ATTACHMENT_PATH_BYTES_V2 = 4096;
const MAX_AGENT_ATTACHMENT_ID_BYTES_V2 = 512;

export class SessionInputAttachmentErrorV2 extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionInputAttachmentErrorV2';
  }
}

export function decodeAgentInputAttachmentsV2(
  value: unknown
): AgentInputAttachmentV2[] {
  if (!Array.isArray(value)) {
    throw invalid(
      'session_input_attachments_invalid',
      'Input attachments must be an array.'
    );
  }
  if (value.length > MAX_AGENT_INPUT_ATTACHMENTS_V2) {
    throw invalid(
      'session_input_attachments_too_many',
      `At most ${MAX_AGENT_INPUT_ATTACHMENTS_V2} attachments are allowed for one user input.`
    );
  }
  const paths = new Set<string>();
  return value.map((candidate) => {
    const record = exactAttachmentObject(candidate);
    const kind = record.kind;
    if (kind !== 'file' && kind !== 'directory') {
      throw invalid(
        'session_input_attachment_kind_invalid',
        'Attachment kind must be file or directory.'
      );
    }
    const scope = record.scope;
    if (scope !== 'message' && scope !== 'session') {
      throw invalid(
        'session_input_attachment_scope_invalid',
        'Attachment scope must be message or session.'
      );
    }
    const path = workspaceRelativePath(record.path);
    if (paths.has(path)) {
      throw invalid(
        'session_input_attachment_duplicate',
        'Attachment paths must be unique within one user input.'
      );
    }
    paths.add(path);
    const resourceId = optionalOpaqueId(
      record.resourceId,
      'resourceId'
    );
    const folderId = optionalOpaqueId(
      record.folderId,
      'folderId'
    );
    return {
      kind,
      path,
      ...(resourceId !== undefined ? { resourceId } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
      scope,
    };
  });
}

export function validateAgentInputAttachmentsV2(
  value: readonly AgentInputAttachmentV2[]
): void {
  decodeAgentInputAttachmentsV2(value);
}

function exactAttachmentObject(
  value: unknown
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(
      'session_input_attachment_invalid',
      'Each input attachment must be an exact object.'
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'kind',
    'path',
    'resourceId',
    'folderId',
    'scope',
  ]);
  const required = ['kind', 'path', 'scope'];
  if (
    Object.keys(record).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalid(
      'session_input_attachment_shape_invalid',
      'Input attachment contains missing or unsupported fields.'
    );
  }
  return record;
}

function workspaceRelativePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid(
      'session_input_attachment_path_invalid',
      'Attachment path must be a normalized workspace-relative path.'
    );
  }
  const bytes = new TextEncoder().encode(value);
  const windowsDriveAbsolute = /^[A-Za-z]:/u.test(value);
  if (
    !value
    || value.trim() !== value
    || bytes.byteLength > MAX_AGENT_ATTACHMENT_PATH_BYTES_V2
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.includes('\\')
    || value.startsWith('/')
    || windowsDriveAbsolute
    || value
      .split('/')
      .some((component) =>
        !component || component === '.' || component === '..'
      )
  ) {
    throw invalid(
      'session_input_attachment_path_invalid',
      'Attachment path must be a normalized workspace-relative path.'
    );
  }
  return value;
}

function optionalOpaqueId(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength
      > MAX_AGENT_ATTACHMENT_ID_BYTES_V2
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw invalid(
      'session_input_attachment_id_invalid',
      `${field} must be a bounded opaque identity.`
    );
  }
  return value;
}

function invalid(
  code: string,
  message: string
): SessionInputAttachmentErrorV2 {
  return new SessionInputAttachmentErrorV2(code, message);
}
