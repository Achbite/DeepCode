import type { HookInput } from './hookInput.js';

export class HookPolicy {
  allows(_input: HookInput): boolean {
    return false;
  }
}
