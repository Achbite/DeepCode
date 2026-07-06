import type { HookInput } from './hookInput.js';
import type { HookResult } from './hookResult.js';
import type { HookType } from './hookType.js';

export interface RegisteredHook {
  readonly id: string;
  readonly type: HookType;
  run(input: HookInput): Promise<HookResult>;
}

export class HookRegistry {
  private readonly hooks: RegisteredHook[] = [];

  register(hook: RegisteredHook): void {
    this.hooks.push(hook);
  }

  list(): readonly RegisteredHook[] {
    return this.hooks;
  }
}
