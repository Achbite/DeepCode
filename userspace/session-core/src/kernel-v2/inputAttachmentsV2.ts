import type { AgentInputAttachmentV3 } from '@deepcode/protocol';
import { sha256Hash } from '../cache/canonicalizer.js';
import type { SessionUserAttachmentContextV1 } from './types.js';

const MAX_AGENT_INPUT_ATTACHMENTS_V3 = 32;
const MAX_AGENT_ATTACHMENT_ID_BYTES_V3 = 512;
const MAX_AGENT_ATTACHMENT_DISPLAY_NAME_BYTES_V3 = 1024;
const MAX_AGENT_ATTACHMENT_CONTEXT_FILES_V1 = 512;
const MAX_AGENT_ATTACHMENT_CONTEXT_BYTES_V1 = 512 * 1024;
const MAX_AGENT_ATTACHMENT_OMISSIONS_V1 = 256;

export class SessionInputAttachmentErrorV3 extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionInputAttachmentErrorV3';
  }
}

export function decodeAgentInputAttachmentsV3(
  value: unknown
): AgentInputAttachmentV3[] {
  if (!Array.isArray(value)) {
    throw invalid(
      'session_input_attachments_invalid',
      'Input attachments must be an array.'
    );
  }
  if (value.length > MAX_AGENT_INPUT_ATTACHMENTS_V3) {
    throw invalid(
      'session_input_attachments_too_many',
      `At most ${MAX_AGENT_INPUT_ATTACHMENTS_V3} attachments are allowed for one user input.`
    );
  }
  const attachmentIds = new Set<string>();
  const resourceIds = new Set<string>();
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
    const attachmentId = opaqueId(record.attachmentId, 'attachmentId');
    const resourceId = opaqueId(record.resourceId, 'resourceId');
    const displayName = boundedDisplayName(record.displayName);
    if (attachmentIds.has(attachmentId) || resourceIds.has(resourceId)) {
      throw invalid(
        'session_input_attachment_duplicate',
        'Attachment and resource identities must be unique within one user input.'
      );
    }
    attachmentIds.add(attachmentId);
    resourceIds.add(resourceId);
    return {
      kind,
      attachmentId,
      resourceId,
      displayName,
      scope,
    };
  });
}

export function validateAgentInputAttachmentsV3(
  value: readonly AgentInputAttachmentV3[]
): void {
  decodeAgentInputAttachmentsV3(value);
}

export function decodeUserAttachmentContextsV1(
  value: unknown,
  attachments: readonly AgentInputAttachmentV3[]
): SessionUserAttachmentContextV1[] {
  if (!Array.isArray(value) || value.length !== attachments.length) {
    throw invalid(
      'session_input_attachment_context_invalid',
      'Attachment contexts must exactly match the admitted attachment handles.'
    );
  }
  let totalBytes = 0;
  return value.map((candidate, index) => {
    const record = exactObject(candidate, [
      'schemaVersion',
      'attachmentId',
      'resourceId',
      'displayName',
      'kind',
      'files',
      'omitted',
    ]);
    const attachment = attachments[index]!;
    if (
      record.schemaVersion !== 'deepcode.host.user-attachment-context.v1'
      || record.attachmentId !== attachment.attachmentId
      || record.resourceId !== attachment.resourceId
      || record.displayName !== attachment.displayName
      || record.kind !== attachment.kind
      || !Array.isArray(record.files)
      || record.files.length > MAX_AGENT_ATTACHMENT_CONTEXT_FILES_V1
      || !Array.isArray(record.omitted)
      || record.omitted.length > MAX_AGENT_ATTACHMENT_OMISSIONS_V1
    ) {
      throw invalid(
        'session_input_attachment_context_invalid',
        'Attachment context does not match its exact Host grant.'
      );
    }
    const files = record.files.map((file) => {
      const item = exactObject(file, [
        'path',
        'content',
        'sizeBytes',
        'contentHash',
      ]);
      const path = relativeContextPath(item.path);
      if (
        typeof item.content !== 'string'
        || typeof item.sizeBytes !== 'number'
        || !Number.isSafeInteger(item.sizeBytes)
        || item.sizeBytes < 0
        || new TextEncoder().encode(item.content).byteLength !== item.sizeBytes
        || item.contentHash !== sha256Hash(item.content)
      ) {
        throw invalid(
          'session_input_attachment_context_file_invalid',
          'Attachment context file content or digest is invalid.'
        );
      }
      totalBytes += item.sizeBytes;
      if (totalBytes > MAX_AGENT_ATTACHMENT_CONTEXT_BYTES_V1) {
        throw invalid(
          'session_input_attachment_context_too_large',
          'Combined attachment context exceeds the Session limit.'
        );
      }
      return {
        path,
        content: item.content,
        sizeBytes: item.sizeBytes,
        contentHash: item.contentHash as string,
      };
    });
    const omitted = record.omitted.map((omission) => {
      const item = exactObject(omission, ['path', 'reason']);
      return {
        path: relativeContextPath(item.path),
        reason: opaqueId(item.reason, 'omission.reason'),
      };
    });
    return {
      schemaVersion: record.schemaVersion,
      attachmentId: attachment.attachmentId,
      resourceId: attachment.resourceId,
      displayName: attachment.displayName,
      kind: attachment.kind,
      files,
      omitted,
    };
  });
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
    'attachmentId',
    'resourceId',
    'displayName',
    'scope',
  ]);
  const required = [...allowed];
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

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(
      'session_input_attachment_context_invalid',
      'Attachment context entries must be exact objects.'
    );
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !expected.has(key))
    || keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalid(
      'session_input_attachment_context_invalid',
      'Attachment context contains missing or unsupported fields.'
    );
  }
  return record;
}

function opaqueId(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > MAX_AGENT_ATTACHMENT_ID_BYTES_V3
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw invalid(
      'session_input_attachment_id_invalid',
      `${field} must be a bounded opaque identity.`
    );
  }
  return value;
}

function boundedDisplayName(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength
      > MAX_AGENT_ATTACHMENT_DISPLAY_NAME_BYTES_V3
    || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(value)
    || value === '.'
    || value === '..'
  ) {
    throw invalid(
      'session_input_attachment_display_name_invalid',
      'displayName must be a bounded filename without path separators.'
    );
  }
  return value;
}

function relativeContextPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw invalid(
      'session_input_attachment_context_path_invalid',
      'Attachment context paths must be normalized and relative.'
    );
  }
  return value;
}

function invalid(
  code: string,
  message: string
): SessionInputAttachmentErrorV3 {
  return new SessionInputAttachmentErrorV3(code, message);
}
