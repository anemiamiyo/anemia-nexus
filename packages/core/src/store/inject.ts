/**
 * Crash-injection hooks for the F16 fixture (docs/17-testing.md 17.1.1,
 * docs/12-indexing.md 12.3.3). Product builds leave `NEXUS_CRASH_AT` unset;
 * the hooks are inert. Tests set it to one of the names below and the child
 * process kills itself with SIGKILL, which is the closest portable simulation
 * of power loss.
 */
export const CRASH_POINTS = [
  'after-rows-before-commit',
  'after-commit-before-flip',
  'after-flip-before-manifest',
  'manifest-tmp-written',
  'after-manifest-before-surface',
  'after-surface-before-workspace',
  'workspace-before-cleanup',
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

export function crashPoint(name: CrashPoint): void {
  if (process.env.NEXUS_CRASH_AT !== name) return;
  // SIGKILL leaves no chance to flush application buffers; WAL/file state is
  // exactly what recovery must handle.
  process.kill(process.pid, 'SIGKILL');
  // On platforms where SIGKILL cannot be raised, fall back to an abrupt exit.
  process.exit(137);
}
