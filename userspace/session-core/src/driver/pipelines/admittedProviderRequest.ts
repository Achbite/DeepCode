import type { LlmChatRequest } from '@deepcode/protocol';
import { stableHash } from '../../cache/canonicalizer.js';

export type ProviderAttemptKind =
  | 'primary'
  | 'resume'
  | 'repair'
  | 'emptyRetry'
  | 'streamFallback'
  | 'review';

export interface AdmittedProviderRequest {
  readonly schemaVersion: 'deepcode.session.admitted-provider-request.v1';
  readonly requestId: string;
  readonly parentRequestId?: string;
  readonly attemptKind: ProviderAttemptKind;
  readonly stage: string;
  readonly languageRevision?: number;
  readonly transportRequest: LlmChatRequest;
  readonly providerPayloadDigest: string;
  readonly transportDigest: string;
}

export interface AdmittedProviderRequestSnapshot {
  readonly schemaVersion: 'deepcode.session.admitted-provider-request-snapshot.v1';
  readonly requestId: string;
  readonly parentRequestId?: string;
  readonly attemptKind: ProviderAttemptKind;
  readonly stage: string;
  readonly languageRevision?: number;
  readonly profileId?: string;
  readonly stream: boolean;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly responseFormat?: unknown;
  readonly providerPayloadDigest: string;
  readonly transportDigest: string;
}

export function admitProviderRequest(input: {
  requestId: string;
  parentRequestId?: string;
  attemptKind: ProviderAttemptKind;
  stage: string;
  languageRevision?: number;
  transportRequest: LlmChatRequest;
}): AdmittedProviderRequest {
  const providerPayload = {
    profileId: input.transportRequest.profileId ?? null,
    messages: input.transportRequest.messages,
    tools: input.transportRequest.tools ?? [],
    responseFormat: input.transportRequest.responseFormat ?? null,
    stream: input.transportRequest.stream === true,
  };
  return Object.freeze({
    schemaVersion: 'deepcode.session.admitted-provider-request.v1',
    requestId: input.requestId,
    parentRequestId: input.parentRequestId,
    attemptKind: input.attemptKind,
    stage: input.stage,
    languageRevision: input.languageRevision,
    transportRequest: input.transportRequest,
    providerPayloadDigest: stableHash(JSON.stringify(providerPayload)),
    transportDigest: stableHash(JSON.stringify(input.transportRequest)),
  });
}

export function admittedProviderRequestSnapshot(
  admitted: AdmittedProviderRequest
): AdmittedProviderRequestSnapshot {
  return {
    schemaVersion: 'deepcode.session.admitted-provider-request-snapshot.v1',
    requestId: admitted.requestId,
    parentRequestId: admitted.parentRequestId,
    attemptKind: admitted.attemptKind,
    stage: admitted.stage,
    languageRevision: admitted.languageRevision,
    profileId: admitted.transportRequest.profileId,
    stream: admitted.transportRequest.stream === true,
    messageCount: admitted.transportRequest.messages.length,
    toolCount: admitted.transportRequest.tools?.length ?? 0,
    responseFormat: admitted.transportRequest.responseFormat,
    providerPayloadDigest: admitted.providerPayloadDigest,
    transportDigest: admitted.transportDigest,
  };
}

export function providerAttemptKindForStage(stage: string): ProviderAttemptKind {
  const normalized = stage.toLowerCase();
  if (normalized.includes('empty') && normalized.includes('retry')) return 'emptyRetry';
  if (normalized.includes('repair')) return 'repair';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('resume')) return 'resume';
  return 'primary';
}
