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
