/** Display-only API. Plugins receive no Session, Provider, tool or permission ports. */
export type UiPluginSlot =
  | 'message.plain'
  | 'message.markdown'
  | 'document.html'
  | 'document.markdown'
  | 'document.pdf'
  | 'theme';
export interface UiPluginManifest {
  id: string;
  name: string;
  entry: string;
  description?: string;
  slots: UiPluginSlot[];
}
export interface UiPluginSource {
  path: string;
  enabled: boolean;
}
export interface UiPluginFile extends UiPluginSource {
  manifest: UiPluginManifest | null;
  source: string | null;
  error: string | null;
}
export type UiPluginInput = Readonly<
  | {
      kind: 'message';
      text: string;
      format: 'plain' | 'markdown';
      locale: string;
      theme: string;
    }
  | {
      kind: 'document';
      blob: Blob;
      filename: string;
      format: 'html' | 'markdown' | 'pdf';
      locale: string;
      theme: string;
    }
>;
export interface UiPluginScope {
  readonly signal: AbortSignal;
  onDispose(dispose: () => void | Promise<void>): void;
  addStyle(css: string): void;
  reportError(error: unknown): void;
}
export interface UiPluginView {
  update(input: UiPluginInput): void;
  dispose(): void | Promise<void>;
}
export type UiPluginRenderer = (
  container: HTMLElement,
  input: UiPluginInput,
  scope: UiPluginScope,
) => UiPluginView;
export interface UiPluginContext extends UiPluginScope {
  register(slot: Exclude<UiPluginSlot, 'theme'>, renderer: UiPluginRenderer): void;
}
export interface UiPluginModule {
  apply(
    context: UiPluginContext,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
