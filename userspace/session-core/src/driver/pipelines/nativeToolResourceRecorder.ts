import type { AgentEvent } from '@deepcode/protocol';
import type {
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type {
  NativeToolReadLedgerEntry,
  NativeToolReadSignature,
} from '../../provider/providerStreamParts.js';

export interface NativeToolResourceRecorderState {
  sessionId: string;
  manifest: ResourceManifest;
  resourcePackets: ResourcePacket[];
  nativeToolReadLedger: Map<string, NativeToolReadLedgerEntry>;
}

export interface NativeToolResourceRecorderPorts {
  packetContentHash(packet: ResourcePacket): string;
  addDiscoveredManifestEntries(manifest: ResourceManifest, packet: ResourcePacket): void;
  packetEvent(sessionId: string, packet: ResourcePacket, ts: string, id: string): AgentEvent;
}

export class NativeToolResourceRecorder {
  constructor(private readonly ports: NativeToolResourceRecorderPorts) {}

  recordResolvedPacket(
    state: NativeToolResourceRecorderState,
    signature: NativeToolReadSignature,
    packet: ResourcePacket,
    eventRef: { ts: string; id: string }
  ): AgentEvent {
    state.nativeToolReadLedger.set(signature.key, {
      signature,
      packet,
      contentHash: this.ports.packetContentHash(packet),
      repeatCount: 0,
    });
    state.resourcePackets.push(packet);
    this.ports.addDiscoveredManifestEntries(state.manifest, packet);
    return this.ports.packetEvent(state.sessionId, packet, eventRef.ts, eventRef.id);
  }
}
