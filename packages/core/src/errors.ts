/**
 * Error codes E00–E24 are a stable contract (docs/16-nfr-and-errors.md 16.3).
 * Only the code decides failure type; natural-language text is never parsed.
 */
export type ErrorCode =
  | 'E00'
  | 'E01'
  | 'E02'
  | 'E03'
  | 'E04'
  | 'E05'
  | 'E06'
  | 'E07'
  | 'E08'
  | 'E09'
  | 'E10'
  | 'E11'
  | 'E12'
  | 'E13'
  | 'E14'
  | 'E15'
  | 'E16'
  | 'E17'
  | 'E18'
  | 'E19'
  | 'E20'
  | 'E21'
  | 'E22'
  | 'E23'
  | 'E24';

export type ErrorCategory =
  | 'param'
  | 'index'
  | 'config'
  | 'db'
  | 'resource'
  | 'permission'
  | 'analyzer'
  | 'env'
  | 'identity'
  | 'internal'
  | 'unsupported';

export type Severity = 'error' | 'warning';

export const ERROR_META: Readonly<Record<ErrorCode, { category: ErrorCategory }>> = {
  E00: { category: 'param' },
  E01: { category: 'index' },
  E02: { category: 'index' },
  E03: { category: 'config' },
  E04: { category: 'index' },
  E05: { category: 'index' },
  E06: { category: 'db' },
  E07: { category: 'db' },
  E08: { category: 'resource' },
  E09: { category: 'permission' },
  E10: { category: 'resource' },
  E11: { category: 'analyzer' },
  E12: { category: 'permission' },
  E13: { category: 'index' },
  E14: { category: 'env' },
  E15: { category: 'config' },
  E16: { category: 'config' },
  E17: { category: 'config' },
  E18: { category: 'permission' },
  E19: { category: 'db' },
  E20: { category: 'resource' },
  E21: { category: 'identity' },
  E22: { category: 'permission' },
  E23: { category: 'internal' },
  E24: { category: 'unsupported' },
};

export interface NexusErrorOptions {
  reason?: string;
  file?: string | null;
  suggestion?: string;
  evidence?: Record<string, unknown>;
  severity?: Severity;
  cause?: unknown;
}

export class NexusError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly reason: string;
  readonly file: string | null;
  readonly suggestion: string;
  readonly evidence: Record<string, unknown>;
  readonly severity: Severity;

  constructor(code: ErrorCode, message: string, options: NexusErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NexusError';
    this.code = code;
    this.category = ERROR_META[code].category;
    this.reason = options.reason ?? message;
    this.file = options.file ?? null;
    this.suggestion = options.suggestion ?? '';
    this.evidence = options.evidence ?? {};
    this.severity = options.severity ?? 'error';
  }
}

export function nexusError(
  code: ErrorCode,
  message: string,
  options: NexusErrorOptions = {},
): NexusError {
  return new NexusError(code, message, options);
}

export function isNexusError(value: unknown): value is NexusError {
  return value instanceof NexusError;
}

export function mapUnknownError(error: unknown): NexusError {
  if (isNexusError(error)) return error;
  if (error instanceof Error) {
    return new NexusError('E23', 'internal error', {
      reason: error.message,
      suggestion: 'Include the build fingerprint and reproduction steps in the report.',
      cause: error,
    });
  }
  return new NexusError('E23', 'internal error', {
    reason: String(error),
    suggestion: 'Include the build fingerprint and reproduction steps in the report.',
  });
}
