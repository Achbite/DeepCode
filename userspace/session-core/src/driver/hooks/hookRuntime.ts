import type { HookInput } from './hookInput.js';
import type { HookResult } from './hookResult.js';
import type { HookRegistry } from './hookRegistry.js';

export class HookRuntime {
  constructor(private readonly registry: HookRegistry) {}

  async run(input: HookInput): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const hook of this.registry.list()) {
      results.push(await hook.run(input));
    }
    return results;
  }
}
