import fs from 'node:fs';
import lockfile from 'proper-lockfile';

import { nexusError } from '../errors.js';

const STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;

/**
 * Per-root writer lock via proper-lockfile (docs/12-indexing.md 12.3.5).
 * Never a custom lock implementation. The lock directory itself must exist.
 */
export async function withRootLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(directory, { recursive: true });
  const retries = Math.max(1, Math.ceil(LOCK_WAIT_MS / 1000));
  const release = await lockfile
    .lock(directory, {
      stale: STALE_MS,
      update: STALE_MS / 2,
      retries: { retries, factor: 1, minTimeout: 1000, maxTimeout: 1000, randomize: false },
      realpath: false,
    })
    .catch((error: unknown) => {
      throw nexusError('E08', 'index lock is held by another process', {
        reason: error instanceof Error ? error.message : String(error),
        file: directory,
        suggestion:
          'Wait for the other build to finish, or remove the stale lock after 10 minutes.',
        evidence: { staleMs: STALE_MS },
      });
    });
  try {
    return await action();
  } finally {
    try {
      await release();
    } catch {
      // Releasing a lock that was already removed must not mask the build result.
    }
  }
}
