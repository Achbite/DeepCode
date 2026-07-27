import type {
  LlmChatRequest,
  SessionProviderAdmissionMetadataV1,
} from '@deepcode/protocol';
import { canonicalJson, sha256Hash } from '../../cache/canonicalizer.js';

export type ProviderAttemptKind =
  | 'primary'
  | 'resume'
  | 'repair'
  | 'emptyRetry'
  | 'streamFallback'
  | 'review';

export interface PendingProviderRetryAdmission {
  readonly attemptKind: Extract<ProviderAttemptKind, 'repair' | 'emptyRetry'>;
  readonly parentRequestId: string;
  readonly reasonCode: string;
  readonly rebaseFromFacts: boolean;
}

export interface AdmittedProviderRequest {
  readonly schemaVersion: 'deepcode.session.admitted-provider-request.v1';
  readonly requestId: string;
  readonly parentRequestId?: string;
  readonly turnAuthorityRef: string;
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
  readonly turnAuthorityRef: string;
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
  turnAuthorityRef: string;
  attemptKind: ProviderAttemptKind;
  stage: string;
  languageRevision?: number;
  transportRequest: LlmChatRequest;
}): AdmittedProviderRequest {
  const requestId = input.requestId.trim();
  const parentRequestId = input.parentRequestId?.trim() || undefined;
  if (!requestId) {
    throw new Error('Admitted Provider request requires a non-empty physical request id.');
  }
  if (!input.turnAuthorityRef.trim()) {
    throw new Error('Admitted Provider request requires an exact turn authority event ref.');
  }
  if (
    input.transportRequest.requestId !== requestId
    || (input.transportRequest.parentRequestId?.trim() || undefined) !== parentRequestId
  ) {
    throw new Error(
      'Admitted Provider identity must exactly match the physical transport request identity.'
    );
  }
  if (parentRequestId === requestId) {
    throw new Error('Admitted Provider request cannot be its own physical parent.');
  }
  const providerPayload = {
    profileId: input.transportRequest.profileId ?? null,
    messages: input.transportRequest.messages,
    tools: input.transportRequest.tools ?? [],
    responseFormat: input.transportRequest.responseFormat ?? null,
    stream: input.transportRequest.stream === true,
  };
  return Object.freeze({
    schemaVersion: 'deepcode.session.admitted-provider-request.v1',
    requestId,
    parentRequestId,
    turnAuthorityRef: input.turnAuthorityRef,
    attemptKind: input.attemptKind,
    stage: input.stage,
    languageRevision: input.languageRevision,
    transportRequest: input.transportRequest,
    providerPayloadDigest: sha256Hash(canonicalJson(providerPayload)),
    transportDigest: sha256Hash(canonicalJson(input.transportRequest)),
  });
}

export function admittedProviderRequestSnapshot(
  admitted: AdmittedProviderRequest
): AdmittedProviderRequestSnapshot {
  return {
    schemaVersion: 'deepcode.session.admitted-provider-request-snapshot.v1',
    requestId: admitted.requestId,
    parentRequestId: admitted.parentRequestId,
    turnAuthorityRef: admitted.turnAuthorityRef,
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

/**
 * Derive the durable, non-secret admission identity from the one canonical
 * request object. This deliberately excludes messages, tools, Provider
 * responses, and raw reasoning.
 */
export function providerAdmissionMetadata(
  admitted: AdmittedProviderRequest
): SessionProviderAdmissionMetadataV1 {
  return Object.freeze({
    schemaVersion: 'deepcode.session.provider-admission-metadata.v1',
    requestId: admitted.requestId,
    parentRequestId: admitted.parentRequestId,
    turnAuthorityRef: admitted.turnAuthorityRef,
    attemptKind: admitted.attemptKind,
    stage: admitted.stage,
    languageRevision: admitted.languageRevision,
    providerPayloadDigest: admitted.providerPayloadDigest,
    transportDigest: admitted.transportDigest,
  });
}

export function providerAttemptKindForStage(stage: string): ProviderAttemptKind {
  const normalized = stage.toLowerCase();
  if (normalized.includes('empty') && normalized.includes('retry')) return 'emptyRetry';
  if (normalized.includes('repair')) return 'repair';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('resume')) return 'resume';
  return 'primary';
}
