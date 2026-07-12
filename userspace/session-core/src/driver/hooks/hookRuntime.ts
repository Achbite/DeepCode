import type { HookInput } from './hookInput.js';
import type { HookResult } from './hookResult.js';
import { HookPolicy } from './hookPolicy.js';
import type { HookRegistry } from './hookRegistry.js';

export class HookRuntime {
  constructor(
    private readonly registry: HookRegistry,
    private readonly policy = new HookPolicy()
  ) {}

  async run(input: HookInput): Promise<HookResult[]> {
    if (!this.policy.allows(input)) return [];
    const results: HookResult[] = [];
    for (const hook of this.registry.list()) {
      try {
        results.push(await hook.run(input));
      } catch {
        results.push({
          status: 'failed',
          errorCode: 'hook_observer_failed',
          recoverable: true,
        });
      }
    }
    return results;
  }
}
