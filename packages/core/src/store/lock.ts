import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { nexusError } from '../errors.js';

const STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;

interface LockOwner {
  pid: number;
  startedAt: string;
}

function lockDirectory(directory: string): string {
  return `${directory}.lock`;
}

function ownerPath(directory: string): string {
  return path.join(lockDirectory(directory), 'owner.json');
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    return code === 'EPERM';
  }
}

/**
 * A SIGKILL'd build leaves the proper-lockfile directory behind. Its mtime
 * would keep it "fresh" for 10 minutes, which would make crash recovery fail
 * with E08. The owner pid file (written by us after acquiring the lock) lets
 * recovery distinguish a dead owner from a live one without reinventing the
 * lock: the directory is still created atomically by proper-lockfile, and a
 * live process is never touched.
 */
function readOwner(directory: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(directory), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

function clearDeadLock(directory: string): boolean {
  const lockPath = lockDirectory(directory);
  if (!fs.existsSync(lockPath)) return false;
  const owner = readOwner(directory);
  if (owner === null || typeof owner.pid !== 'number') return false;
  if (processAlive(owner.pid)) return false;
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-root writer lock via proper-lockfile (docs/12-indexing.md 12.3.5).
 * Never a custom lock implementation. The lock directory itself must exist.
 */
export async function withRootLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(directory, { recursive: true });
  clearDeadLock(directory);
  const retries = Math.max(1, Math.ceil(LOCK_WAIT_MS / 1000));
  const release = await lockfile
    .lock(directory, {
      stale: STALE_MS,
      update: STALE_MS / 2,
      retries: { retries, factor: 1, minTimeout: 1000, maxTimeout: 1000, randomize: false },
      realpath: false,
    })
    .then((releaseLock) => {
      try {
        fs.writeFileSync(
          ownerPath(directory),
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          'utf8',
        );
      } catch {
        // The lock itself is already held; the owner file is recovery metadata.
      }
      return releaseLock;
    })
    .catch((error: unknown) => {
      throw nexusError('E08', 'index lock is held by another process', {
        reason: error instanceof Error ? error.message : String(error),
        file: directory,
        suggestion:
          'Wait for the other build to finish; a lock left by a dead process is cleared automatically.',
        evidence: { staleMs: STALE_MS },
      });
    });
  try {
    return await action();
  } finally {
    // proper-lockfile removes the lock with rmdir(); remove our owner file
    // first so the directory can be removed.
    try {
      fs.rmSync(ownerPath(directory), { force: true });
    } catch {
      // best effort
    }
    try {
      await release();
    } catch {
      // Releasing a lock that was already removed must not mask the build result.
    }
  }
}

export const ROOT_LOCK_STALE_MS = STALE_MS;

/** Recovery helper: remove the lock only when its recorded owner is dead. */
export function clearDeadRootLock(directory: string): boolean {
  return clearDeadLock(directory);
}
