import { AgentPlanParseError } from '../../agent-plan/types.js';

export interface DriverParseErrorInfo {
  code: string;
  message: string;
}

export class DriverParseErrorCatalog {
  normalize(error: unknown): DriverParseErrorInfo {
    if (error instanceof AgentPlanParseError) return { code: error.code, message: error.message };
    if (error instanceof Error) return { code: 'parse_failed', message: error.message };
    return { code: 'parse_failed', message: String(error) };
  }

  message(error: unknown): string {
    return this.normalize(error).message;
  }
}
