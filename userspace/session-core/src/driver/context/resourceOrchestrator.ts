import type {
  AgentEvent,
  AgentSessionResult,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type {
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { ResourceRequestLoop } from './resourceRequestLoop.js';
import type { ResourcePacketActivityIdentity } from './resourceRequestLoop.js';
import {
  conversationPresentationLanguage,
  type ConversationPresentationLanguageState,
} from '../projection/conversationPresentationLanguage.js';

export interface ResourceOrchestratorState extends ConversationPresentationLanguageState {
  sessionId: string;
  runId: string;
  manifest: ResourceManifest;
  resourcePackets: ResourcePacket[];
  resourceEvidenceRevision?: number;
}

export interface ResourceOrchestratorRuntime {
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  id(prefix: string): string;
  ts(): string;
}

export interface ResourceOrchestratorInput {
  resourceRequestLoop: ResourceRequestLoop;
  runtime: ResourceOrchestratorRuntime;
  createError(code: string, message: string): Error;
}

export interface ResourcePacketRecordOptions {
  discoverManifestEntries?: boolean;
  activityIdentity?: ResourcePacketActivityIdentity;
}

export interface ResourcePacketAppendResult {
  packet: ResourcePacket;
  event: AgentEvent;
  result: AgentSessionResult;
}

export class ResourceOrchestrator<State extends ResourceOrchestratorState = ResourceOrchestratorState> {
  constructor(private readonly input: ResourceOrchestratorInput) {}

  async resolve(state: State, manifest: ResourceManifest): Promise<ResourcePacket> {
    const packet = await this.input.resourceRequestLoop.resolvePacket(state, manifest, {
      kernelCommand: (request) => this.input.runtime.kernel(request),
      createId: (prefix) => this.input.runtime.id(prefix),
    });
    if (!packet) {
      throw this.input.createError('resource_packet_missing', 'Kernel ResourceResolve did not produce a ResourcePacket.');
    }
    return packet;
  }

  async resolveAndRecord(
    state: State,
    manifest: ResourceManifest,
    options: ResourcePacketRecordOptions = { discoverManifestEntries: true }
  ): Promise<ResourcePacket> {
    const packet = await this.resolve(state, manifest);
    this.recordPacket(state, packet, options);
    return packet;
  }

  async resolveRecordAndAppend(
    state: State,
    manifest: ResourceManifest,
    eventIdPrefix: string,
    options: ResourcePacketRecordOptions = { discoverManifestEntries: true }
  ): Promise<ResourcePacketAppendResult> {
    const packet = await this.resolveAndRecord(state, manifest, options);
    return this.appendRecordedPacket(state, packet, eventIdPrefix, options);
  }

  async recordAndAppend(
    state: State,
    packet: ResourcePacket,
    eventIdPrefix: string,
    options: ResourcePacketRecordOptions = {}
  ): Promise<ResourcePacketAppendResult> {
    this.recordPacket(state, packet, options);
    return this.appendRecordedPacket(state, packet, eventIdPrefix, options);
  }

  recordPacket(
    state: State,
    packet: ResourcePacket,
    options: ResourcePacketRecordOptions = {}
  ): void {
    state.resourcePackets.push(packet);
    state.resourceEvidenceRevision = (state.resourceEvidenceRevision ?? 0) + 1;
    if (options.discoverManifestEntries) {
      this.input.resourceRequestLoop.addDiscoveredManifestEntries(state.manifest, packet);
    }
  }

  packetEvent(
    state: State,
    packet: ResourcePacket,
    eventIdPrefix: string,
    options: ResourcePacketRecordOptions = {}
  ): AgentEvent {
    return this.input.resourceRequestLoop.packetEvent(
      state.sessionId,
      packet,
      this.input.runtime.ts(),
      this.input.runtime.id(eventIdPrefix),
      conversationPresentationLanguage(state),
      options.activityIdentity
    );
  }

  private async appendRecordedPacket(
    state: State,
    packet: ResourcePacket,
    eventIdPrefix: string,
    options: ResourcePacketRecordOptions
  ): Promise<ResourcePacketAppendResult> {
    const event = this.packetEvent(state, packet, eventIdPrefix, options);
    const result = await this.input.runtime.append(state.sessionId, [event]);
    return { packet, event, result };
  }
}
