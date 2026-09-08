import type {
  LocalAgentError,
  PresentationArtifactBlock,
  PresentationBlock,
  PresentationBlockKind,
  PresentationContentResolution,
  PresentationLinkBlock,
  PresentationProviderPort,
  PresentationRenderContext,
  PresentationRendererDescriptor,
  PresentationRendererStatus,
  PresentationStatusBlock,
} from '@deepcode/protocol';

const ALL_BLOCK_KINDS = [
  'text',
  'group',
  'section',
  'code',
  'keyValue',
  'status',
  'link',
  'artifact',
  'action',
] as const satisfies readonly [PresentationBlockKind, ...PresentationBlockKind[]];

const BUILTIN_DESCRIPTOR: PresentationRendererDescriptor = {
  rendererId: 'deepcode.presentation.builtin',
  contributionRef: 'coreBuiltin:presentation',
  origin: 'builtin',
  supportedBlockKinds: ALL_BLOCK_KINDS,
};

function validateRendererDescriptor<Output>(
  renderer: PresentationProviderPort<Output>,
  descriptor: PresentationRendererDescriptor,
  expectedOrigin: PresentationRendererDescriptor['origin'],
): ReadonlySet<PresentationBlockKind> {
  if (
    descriptor.origin !== expectedOrigin
    || !descriptor.rendererId.trim()
    || !descriptor.contributionRef.trim()
  ) {
    throw new Error(`Invalid ${expectedOrigin} Presentation renderer identity.`);
  }
  if (descriptor.origin === 'extension') {
    if (!descriptor.extensionGenerationRef.trim() || !descriptor.pluginInstanceRef.trim()) {
      throw new Error('Extension Presentation renderer identity is incomplete.');
    }
  } else if (
    descriptor.extensionGenerationRef !== undefined
    || descriptor.pluginInstanceRef !== undefined
  ) {
    throw new Error('Builtin Presentation renderer cannot carry extension identity.');
  }
  if (descriptor.supportedBlockKinds.length === 0) {
    throw new Error('Presentation renderer must support at least one block kind.');
  }
  const supportedKinds = new Set<PresentationBlockKind>();
  for (const kind of descriptor.supportedBlockKinds) {
    if (!ALL_BLOCK_KINDS.includes(kind) || supportedKinds.has(kind)) {
      throw new Error(`Invalid or duplicate Presentation block kind ${String(kind)}.`);
    }
    supportedKinds.add(kind);
  }
  for (const kind of ALL_BLOCK_KINDS) {
    if (renderer.supportsBlockKind(kind) !== supportedKinds.has(kind)) {
      throw new Error(
        `Renderer descriptor and supportsBlockKind disagree for ${kind}.`,
      );
    }
  }
  return supportedKinds;
}

function asLocalAgentError(code: string, error: unknown): LocalAgentError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function unavailableBlock(error: LocalAgentError): PresentationStatusBlock {
  return {
    kind: 'status',
    blockId: `renderer:unavailable:${error.code}`,
    source: { kind: 'renderer', id: error.code },
    region: 'diagnostic',
    state: 'unavailable',
    label: 'Presentation renderer unavailable',
    detail: error.message,
    error,
  };
}

export class BuiltinPassthroughPresentationRenderer
  implements PresentationProviderPort<PresentationBlock>
{
  describeRenderer(): PresentationRendererDescriptor {
    return BUILTIN_DESCRIPTOR;
  }

  prepareRenderer(): void {}

  supportsBlockKind(kind: PresentationBlockKind): boolean {
    return ALL_BLOCK_KINDS.includes(kind);
  }

  renderPresentationBlock(block: PresentationBlock): PresentationBlock {
    return block;
  }

  async resolveContentLink(
    block: PresentationLinkBlock | PresentationArtifactBlock,
  ): Promise<PresentationContentResolution> {
    if (block.uri) {
      return { status: 'resolved', uri: block.uri };
    }
    return {
      status: 'unavailable',
      error: {
        code: 'presentation_content_unavailable',
        message: `Presentation block ${block.blockId} does not expose a URI.`,
      },
    };
  }

  disposeRenderer(): void {}
}

export interface PresentationRendererRegistrySnapshot {
  revision: number;
  status: PresentationRendererStatus;
}

export type PresentationRendererRegistryListener = (
  snapshot: PresentationRendererRegistrySnapshot,
) => void;

export class PresentationRendererRegistry<Output> {
  readonly #builtin: PresentationProviderPort<Output>;
  readonly #builtinDescriptor: PresentationRendererDescriptor;
  readonly #builtinSupportedKinds: ReadonlySet<PresentationBlockKind>;
  #active: PresentationProviderPort<Output>;
  #activeDescriptor: PresentationRendererDescriptor;
  #activeSupportedKinds: ReadonlySet<PresentationBlockKind>;
  #revision = 0;
  #status: PresentationRendererStatus;
  #disposed = false;
  #transition: Promise<void> = Promise.resolve();
  readonly #disposedRenderers = new Set<PresentationProviderPort<Output>>();
  readonly #listeners = new Set<PresentationRendererRegistryListener>();

  constructor(builtin: PresentationProviderPort<Output>) {
    this.#builtin = builtin;
    this.#active = builtin;
    this.#builtinDescriptor = builtin.describeRenderer();
    this.#builtinSupportedKinds = validateRendererDescriptor(
      builtin,
      this.#builtinDescriptor,
      'builtin',
    );
    if (this.#builtinSupportedKinds.size !== ALL_BLOCK_KINDS.length) {
      throw new Error('Builtin Presentation renderer must support every block kind.');
    }
    this.#activeDescriptor = this.#builtinDescriptor;
    this.#activeSupportedKinds = this.#builtinSupportedKinds;
    this.#status = { state: 'ready', active: this.#activeDescriptor };
  }

  snapshot(): PresentationRendererRegistrySnapshot {
    return { revision: this.#revision, status: this.#status };
  }

  subscribe(listener: PresentationRendererRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  activate(candidate: PresentationProviderPort<Output>): Promise<PresentationRendererStatus> {
    return this.#enqueue(async () => {
      if (this.#disposed) {
        throw new Error('Presentation renderer registry is disposed.');
      }
      if (candidate === this.#active) {
        return this.#status;
      }

      let descriptor: PresentationRendererDescriptor | undefined;
      let supportedKinds: ReadonlySet<PresentationBlockKind> | undefined;
      try {
        if (this.#disposedRenderers.has(candidate)) {
          throw new Error('A disposed Presentation renderer cannot be reactivated.');
        }
        descriptor = candidate.describeRenderer();
        supportedKinds = validateRendererDescriptor(candidate, descriptor, 'extension');
        await candidate.prepareRenderer();
      } catch (cause) {
        const error = asLocalAgentError('presentation_renderer_prepare_failed', cause);
        this.#status = {
          state: 'unavailable',
          active: this.#activeDescriptor,
          failed: descriptor,
          error,
        };
        this.#publish();
        await this.#disposeRenderer(candidate);
        return this.#status;
      }

      const previous = this.#active;
      this.#active = candidate;
      this.#activeDescriptor = descriptor;
      this.#activeSupportedKinds = supportedKinds;
      this.#status = { state: 'ready', active: descriptor };
      this.#publish();
      if (previous !== this.#builtin) {
        await this.#disposeRenderer(previous);
      }
      return this.#status;
    });
  }

  deactivate(): Promise<PresentationRendererStatus> {
    return this.#enqueue(async () => {
      if (this.#disposed) {
        throw new Error('Presentation renderer registry is disposed.');
      }
      const previous = this.#active;
      this.#active = this.#builtin;
      this.#activeDescriptor = this.#builtinDescriptor;
      this.#activeSupportedKinds = this.#builtinSupportedKinds;
      this.#status = { state: 'ready', active: this.#activeDescriptor };
      this.#publish();
      if (previous !== this.#builtin) {
        await this.#disposeRenderer(previous);
      }
      return this.#status;
    });
  }

  render(
    blocks: readonly PresentationBlock[],
    context?: PresentationRenderContext,
  ): Output[] {
    if (this.#disposed) {
      throw new Error('Presentation renderer registry is disposed.');
    }
    const rendered: Output[] = [];
    if (this.#status.state === 'unavailable') {
      rendered.push(
        this.#builtin.renderPresentationBlock(
          unavailableBlock(this.#status.error),
          context,
        ),
      );
    }
    for (let index = 0; index < blocks.length; index += 1) {
      const renderer = this.#activeSupportedKinds.has(blocks[index].kind)
        ? this.#active
        : this.#builtin;
      try {
        rendered.push(renderer.renderPresentationBlock(blocks[index], context));
      } catch (cause) {
        if (renderer === this.#builtin) {
          throw cause;
        }
        const failed = this.#active;
        const failedDescriptor = this.#activeDescriptor;
        const error = asLocalAgentError('presentation_renderer_render_failed', cause);
        this.#active = this.#builtin;
        this.#activeDescriptor = this.#builtinDescriptor;
        this.#activeSupportedKinds = this.#builtinSupportedKinds;
        this.#status = {
          state: 'unavailable',
          active: this.#activeDescriptor,
          failed: failedDescriptor,
          error,
        };
        this.#publish();
        rendered.push(
          this.#builtin.renderPresentationBlock(unavailableBlock(error), context),
        );
        for (let fallbackIndex = index; fallbackIndex < blocks.length; fallbackIndex += 1) {
          rendered.push(
            this.#builtin.renderPresentationBlock(blocks[fallbackIndex], context),
          );
        }
        void this.#enqueue(async () => {
          try {
            await this.#disposeRenderer(failed);
          } catch (disposeCause) {
            const disposeError = asLocalAgentError(
              'presentation_renderer_dispose_failed',
              disposeCause,
            );
            this.#status = {
              state: 'unavailable',
              active: this.#activeDescriptor,
              failed: failedDescriptor,
              error: disposeError,
            };
            this.#publish();
          }
        });
        break;
      }
    }
    return rendered;
  }

  resolveContentLink(
    block: PresentationLinkBlock | PresentationArtifactBlock,
  ): Promise<PresentationContentResolution> {
    if (this.#disposed) {
      return Promise.resolve({
        status: 'unavailable',
        error: {
          code: 'presentation_renderer_disposed',
          message: 'Presentation renderer registry is disposed.',
        },
      });
    }
    const renderer = this.#activeSupportedKinds.has(block.kind)
      ? this.#active
      : this.#builtin;
    return renderer.resolveContentLink(block);
  }

  dispose(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#disposed) {
        return;
      }
      this.#disposed = true;
      const active = this.#active;
      if (active !== this.#builtin) {
        await this.#disposeRenderer(active);
      }
      await this.#disposeRenderer(this.#builtin);
      this.#status = { state: 'disposed' };
      this.#publish();
      this.#listeners.clear();
    });
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#transition.then(operation, operation);
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #disposeRenderer(renderer: PresentationProviderPort<Output>): Promise<void> {
    if (this.#disposedRenderers.has(renderer)) {
      return;
    }
    this.#disposedRenderers.add(renderer);
    await renderer.disposeRenderer();
  }

  #publish(): void {
    this.#revision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
