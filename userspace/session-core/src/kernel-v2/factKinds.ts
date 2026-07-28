export const SESSION_KERNEL_FACT_KINDS_V2 = Object.freeze({
  authorization: Object.freeze({
    capabilityIssued: 'capabilityIssued',
    capabilityDenied: 'capabilityDenied',
    expansionAllowed: 'expansionAllowed',
    expansionDenied: 'expansionDenied',
    scopePreviewed: 'scopePreviewed',
    contextInvalidated: 'contextInvalidated',
  }),
  invocation: Object.freeze({
    rejected: 'rejected',
    completed: 'toolCompleted',
    failedBeforeEffect: 'toolFailedBeforeEffect',
    cancelledBeforeEffect: 'toolCancelledBeforeEffect',
    timedOutBeforeEffect: 'toolTimedOutBeforeEffect',
    failedAfterObservedEffect: 'toolFailedAfterObservedEffect',
    indeterminate: 'toolIndeterminate',
  }),
  effect: Object.freeze({
    observed: 'toolObserved',
    observedAfterCancel: 'toolObservedAfterCancel',
    observedAfterDeadline: 'toolObservedAfterDeadline',
    observedAfterCancelAndDeadline:
      'toolObservedAfterCancelAndDeadline',
    indeterminate: 'toolIndeterminate',
  }),
  cleanup: Object.freeze({
    scheduled: 'scheduled',
    attempted: 'attempted',
    completed: 'completed',
    failed: 'failed',
  }),
} as const);

export const SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2 =
  new Set<string>([
    SESSION_KERNEL_FACT_KINDS_V2.invocation.completed,
    SESSION_KERNEL_FACT_KINDS_V2.invocation.failedBeforeEffect,
    SESSION_KERNEL_FACT_KINDS_V2.invocation.cancelledBeforeEffect,
    SESSION_KERNEL_FACT_KINDS_V2.invocation.timedOutBeforeEffect,
    SESSION_KERNEL_FACT_KINDS_V2.invocation.failedAfterObservedEffect,
    SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate,
  ]);

export const SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2 =
  new Set<string>([
    SESSION_KERNEL_FACT_KINDS_V2.effect.observed,
    SESSION_KERNEL_FACT_KINDS_V2.effect.observedAfterCancel,
    SESSION_KERNEL_FACT_KINDS_V2.effect.observedAfterDeadline,
    SESSION_KERNEL_FACT_KINDS_V2.effect.observedAfterCancelAndDeadline,
  ]);
