export class LoopFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LoopFailure';
  }
}

export class ProviderReportedFailure extends LoopFailure {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ProviderReportedFailure';
  }
}

/** A completed Provider response could not be interpreted; its completion is known. */
export class ProviderCompletedFailure extends LoopFailure {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ProviderCompletedFailure';
  }
}
