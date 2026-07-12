export type HookEffect =
  | {
    readonly kind: 'appendTrace';
    readonly data: unknown;
  }
  | {
    readonly kind: 'emitDiagnostic';
    readonly diagnosticKey: string;
    readonly args?: Record<string, unknown>;
  };

export type HookResult =
  | {
    readonly status: 'ok';
    readonly effects?: readonly HookEffect[];
  }
  | {
    readonly status: 'blocked';
    readonly reasonCode: string;
    readonly diagnosticKey: string;
    readonly args?: Record<string, unknown>;
  }
  | {
    readonly status: 'failed';
    readonly errorCode: string;
    readonly recoverable: boolean;
  };

export function hookResultEffects(result: HookResult): readonly HookEffect[] {
  return result.status === 'ok' ? result.effects ?? [] : [];
}
