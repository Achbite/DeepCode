import type { ConversationCommand, LocalAgentError } from './localAgent.js';

export const PRESENTATION_PROTOCOL_VERSION = 'deepcode.presentation' as const;

export type PresentationSourceKind =
  | 'session'
  | 'message'
  | 'narrative'
  | 'assistantDraft'
  | 'interaction'
  | 'approval'
  | 'plan'
  | 'todo'
  | 'usage'
  | 'run'
  | 'activity'
  | 'artifact'
  | 'error'
  | 'renderer';

export interface PresentationSourceIdentity {
  kind: PresentationSourceKind;
  id: string;
  sequence?: number;
}

export type PresentationRegion =
  | 'timeline'
  | 'transient'
  | 'decision'
  | 'summary'
  | 'diagnostic';

interface PresentationBlockBase {
  blockId: string;
  source: PresentationSourceIdentity;
  region: PresentationRegion;
}

export interface PresentationTextBlock extends PresentationBlockBase {
  kind: 'text';
  text: string;
  format: 'plain' | 'markdown';
  role?: 'user' | 'assistant' | 'tool' | 'system' | 'narrative' | 'draft';
}

export interface PresentationGroupBlock extends PresentationBlockBase {
  kind: 'group';
  label?: string;
  collapsedByDefault?: boolean;
  children: PresentationBlock[];
}

export interface PresentationSectionBlock extends PresentationBlockBase {
  kind: 'section';
  title?: string;
  children: PresentationBlock[];
}

export interface PresentationCodeBlock extends PresentationBlockBase {
  kind: 'code';
  code: string;
  language?: string;
  label?: string;
}

export interface PresentationKeyValueEntry {
  key: string;
  value: string;
}

export interface PresentationKeyValueBlock extends PresentationBlockBase {
  kind: 'keyValue';
  entries: PresentationKeyValueEntry[];
}

export type PresentationStatusState =
  | 'running'
  | 'releasing'
  | 'active'
  | 'requested'
  | 'waiting'
  | 'completed'
  | 'denied'
  | 'failed'
  | 'releaseFailed'
  | 'cancelled'
  | 'indeterminate'
  | 'published'
  | 'revisionRequested'
  | 'confirmed'
  | 'superseded'
  | 'invalidated'
  | 'pending'
  | 'inProgress'
  | 'unavailable';

export interface PresentationStatusBlock extends PresentationBlockBase {
  kind: 'status';
  state: PresentationStatusState;
  label: string;
  detail?: string;
  error?: LocalAgentError;
}

export interface PresentationLinkBlock extends PresentationBlockBase {
  kind: 'link';
  label: string;
  uri: string;
}

export interface PresentationArtifactBlock extends PresentationBlockBase {
  kind: 'artifact';
  artifactId: string;
  label: string;
  workspaceId?: string;
  logicalPath?: string;
  uri?: string;
}

type WithoutCommandId<Command> = Command extends ConversationCommand
  ? Omit<Command, 'commandId'>
  : never;

/** The shell supplies a fresh commandId when dispatching this existing command shape. */
export type PresentationConversationCommandIntent = WithoutCommandId<ConversationCommand>;

export interface PresentationActionBlock extends PresentationBlockBase {
  kind: 'action';
  actionId: string;
  label: string;
  command: PresentationConversationCommandIntent;
}

export type PresentationBlock =
  | PresentationTextBlock
  | PresentationGroupBlock
  | PresentationSectionBlock
  | PresentationCodeBlock
  | PresentationKeyValueBlock
  | PresentationStatusBlock
  | PresentationLinkBlock
  | PresentationArtifactBlock
  | PresentationActionBlock;

export type PresentationBlockKind = PresentationBlock['kind'];

interface PresentationRendererDescriptorBase {
  rendererId: string;
  contributionRef: string;
  supportedBlockKinds: readonly [PresentationBlockKind, ...PresentationBlockKind[]];
}

export type PresentationRendererDescriptor =
  | (PresentationRendererDescriptorBase & {
      origin: 'builtin';
      extensionGenerationRef?: never;
      pluginInstanceRef?: never;
    })
  | (PresentationRendererDescriptorBase & {
      origin: 'extension';
      extensionGenerationRef: string;
      pluginInstanceRef: string;
    });

export type PresentationRendererStatus =
  | {
      state: 'ready';
      active: PresentationRendererDescriptor;
    }
  | {
      state: 'unavailable';
      active: PresentationRendererDescriptor;
      failed?: PresentationRendererDescriptor;
      error: LocalAgentError;
    }
  | {
      state: 'disposed';
    };

export interface PresentationRenderContext {
  locale?: string;
}

export type PresentationContentResolution =
  | { status: 'resolved'; uri: string }
  | { status: 'unavailable'; error: LocalAgentError };

export interface PresentationProviderPort<Output> {
  describeRenderer(): PresentationRendererDescriptor;
  prepareRenderer(): Promise<void> | void;
  supportsBlockKind(kind: PresentationBlockKind): boolean;
  renderPresentationBlock(
    block: PresentationBlock,
    context?: PresentationRenderContext,
  ): Output;
  resolveContentLink(
    block: PresentationLinkBlock | PresentationArtifactBlock,
  ): Promise<PresentationContentResolution>;
  disposeRenderer(): Promise<void> | void;
}
