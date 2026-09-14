import type {
  ContextCompositionPartitionKind,
  KernelPort,
  ModelMessage,
  ProviderPort,
  RunPreparationPort,
} from '@deepcode/protocol';

export interface ContextMessageContribution {
  contributionId: string;
  contributionKind: Exclude<ContextCompositionPartitionKind, 'filesystemReferences' | 'tools'>;
  label: string;
  message: ModelMessage;
}

/** Trusted ports assembled by the Host; extension activation remains in Kernel. */
export interface AgentComposition {
  provider: ProviderPort;
  kernel: KernelPort;
  runPreparation: RunPreparationPort;
  dispose(): Promise<void>;
}
