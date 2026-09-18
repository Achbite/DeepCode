import type { ActivityProjection, ConnectionSummary, ProviderAdapterDescriptor, UsageQuery, UsageReport, AuthFlow, QuotaSnapshot } from '@deepcode/protocol';

export interface UsageReadPort {
  query(query: UsageQuery, signal: AbortSignal): Promise<UsageReport>;
}
export interface ConnectionSettingsPort {
  startLogin(method: 'browser' | 'deviceCode'): Promise<AuthFlow>;
  readLogin(flowId: string, signal: AbortSignal): Promise<AuthFlow>;
  cancelLogin(flowId: string): Promise<AuthFlow>;
  logout(): Promise<void>;
  readQuota(signal: AbortSignal): Promise<QuotaSnapshot>;
}
/** Views have typed inputs and scoped effects; they never receive execution or Session mutation ports. */
export type UiPluginSlot =
  | 'message.plain'
  | 'message.markdown'
  | 'document.html'
  | 'document.markdown'
  | 'document.pdf'
  | 'theme'
  | 'settings.models.overview'
  | 'settings.connection.detail'
  | 'settings.usage.panel'
  | 'tool.result';
export interface UiPluginManifest {
  id: string;
  name: string;
  entry: string;
  description?: string;
  slots: UiPluginSlot[];
  adapterId?: string;
  toolId?: string;
  capabilities?: Array<'usage.read' | 'connection.auth'>;
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
  | { kind: 'settings.models'; connections: readonly ConnectionSummary[]; adapters: readonly ProviderAdapterDescriptor[]; locale: string; theme: string }
  | { kind: 'settings.connection'; connection: ConnectionSummary; locale: string; theme: string }
  | { kind: 'settings.usage'; query: UsageQuery; report: UsageReport; locale: string; theme: string }
  | { kind: 'tool.result'; activity: Readonly<ActivityProjection>; toolId: string; locale: string; theme: string }
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
  readonly usage?: UsageReadPort;
  readonly connection?: ConnectionSettingsPort;
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
