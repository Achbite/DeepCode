import type { HookInput } from './hookInput.js';
import type { HookPoint } from './hookPoint.js';

export class HookPolicy {
  constructor(private readonly allowedPoints: readonly HookPoint[] = []) {}

  allows(input: HookInput): boolean {
    return this.allowedPoints.includes(input.point);
  }

  static observerOnly(): HookPolicy {
    return new HookPolicy(['contextAdmission.after', 'providerCall.before']);
  }
}
