import type { NexusError } from './errors.js';

/**
 * Exit codes are centralized (docs/11-cli.md 11.5). Commands must never call
 * process.exit directly; they throw and the CLI entry maps the code.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_BLOCKING = 1;
export const EXIT_WARNING = 2;
export const EXIT_USAGE = 64;
export const EXIT_INTERNAL = 70;

export type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_BLOCKING
  | typeof EXIT_WARNING
  | typeof EXIT_USAGE
  | typeof EXIT_INTERNAL;

export function exitCodeForError(error: NexusError): ExitCode {
  switch (error.code) {
    case 'E00':
    case 'E16':
      return EXIT_USAGE;
    case 'E23':
      return EXIT_INTERNAL;
    default:
      return EXIT_BLOCKING;
  }
}

export function exitCodeForWarnings(hasBlocking: boolean, hasWarnings: boolean): ExitCode {
  if (hasBlocking) return EXIT_BLOCKING;
  if (hasWarnings) return EXIT_WARNING;
  return EXIT_SUCCESS;
}
