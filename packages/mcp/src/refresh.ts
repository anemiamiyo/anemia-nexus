import {
  buildWorkspace,
  findLiveRootLock,
  loadConfig,
  mapUnknownError,
  nexusError,
  type BuildProgressEvent,
} from 'anemia-core';

import { resolveScope, type RuntimeState } from './runtime.js';

export interface RefreshResult {
  changed: number;
  filesUpdated: number;
  buildFingerprint: string | null;
  staleness: string;
  degraded: string[];
  noop: boolean;
  indexMutation: true;
  rootId: string | null;
  roots: Array<{
    rootId: string;
    mode: string;
    changed: number;
    skipped: boolean;
  }>;
  notes: string[];
}

export interface RefreshInput {
  root?: string;
  roots?: string | string[];
  mode?: string;
  timeoutMs?: number;
  onProgress?: (event: BuildProgressEvent) => void;
}

const MAX_CHANGED_FILES = 200;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 14.1.1 refresh guardrails: incremental only, 200 changed files, shared root
 * lock (wait 0 so a held lock is E08), zero writes when the fingerprint did
 * not change. Global rebuild conditions are rejected by buildWorkspace before
 * any write (refreshGuard).
 */
export async function refreshIndex(
  runtime: RuntimeState,
  input: RefreshInput,
): Promise<RefreshResult> {
  if (runtime.options.readOnly === true) {
    throw nexusError('E24', 'refresh is not available in read-only mode', {
      reason: 'this server was started with --read-only',
      suggestion: 'Restart `nex mcp` without --read-only if refresh is required.',
    });
  }
  if (input.mode !== undefined && input.mode !== 'incremental') {
    throw nexusError('E00', 'refresh only supports incremental mode', {
      reason: `received mode ${JSON.stringify(input.mode)}`,
      suggestion: 'Use mode "incremental" or omit it.',
    });
  }
  const lockedRoot = findLiveRootLock(runtime.projectRoot);
  if (lockedRoot !== null) {
    throw nexusError('E08', 'index lock is held by another process', {
      reason: `root ${lockedRoot} has a live writer lock`,
      suggestion: 'Wait for the other build/update to finish, then call refresh again.',
      evidence: { rootId: lockedRoot },
    });
  }
  const scope = await resolveScope(runtime, { root: input.root, roots: input.roots });
  const loaded = await loadConfig({
    projectRoot: runtime.projectRoot,
    trustConfig: runtime.options.trustConfig === true,
  });
  if (loaded.config === null) {
    throw nexusError('E17', 'configuration is missing', {
      reason: 'refresh cannot rebuild without .nexus/nexus.config.json',
      suggestion: 'Run `nex init --roots all --write-config --yes` in a terminal.',
    });
  }
  const timeoutMs =
    input.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : Math.min(Math.max(Math.floor(input.timeoutMs), 1000), 120_000);
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const result = await buildWorkspace({
      projectRoot: runtime.projectRoot,
      loadedConfig: loaded,
      mode: 'update',
      selectedRootIds: scope.rootId === null ? undefined : [scope.rootId],
      refreshGuard: { maxChangedFiles: MAX_CHANGED_FILES, rejectFullRebuild: true },
      lockWaitMs: 0,
      signal: timeout,
      onProgress: input.onProgress,
    });
    if (timeout.aborted) {
      throw nexusError('E20', 'refresh timed out', {
        reason: `no refresh completed within ${timeoutMs} ms`,
        suggestion: 'Run `nex update` in a terminal for large changes.',
        evidence: { timeoutMs },
      });
    }
    const noop = result.roots.every((root) => root.mode === 'fresh');
    const changed = result.roots.reduce((sum, root) => sum + (root.changed?.total ?? 0), 0);
    const filesUpdated = result.roots.reduce((sum, root) => {
      const counts = root.changed;
      if (counts === undefined) return sum;
      return sum + counts.added + counts.modified + counts.renamed;
    }, 0);
    const degraded = [
      ...new Set(result.roots.flatMap((root) => root.degradedStages ?? root.degraded)),
    ].sort();
    const okRoot = result.roots.find((root) => root.ok);
    const notes: string[] = [];
    if (noop) notes.push('buildFingerprint unchanged; refresh wrote nothing');
    if (result.failedRoots.length > 0) {
      notes.push(`failed roots: ${result.failedRoots.join(', ')}`);
    }
    return {
      changed,
      filesUpdated,
      buildFingerprint: okRoot?.buildFingerprint ?? null,
      staleness: result.failedRoots.length > 0 ? 'stale' : 'fresh',
      degraded,
      noop,
      indexMutation: true,
      rootId:
        scope.rootId ?? (result.roots.length === 1 ? (result.roots[0]?.rootId ?? null) : null),
      roots: result.roots.map((root) => ({
        rootId: root.rootId,
        mode: root.mode ?? 'full',
        changed: root.changed?.total ?? 0,
        skipped: root.skipped === true,
      })),
      notes,
    };
  } catch (error) {
    if (timeout.aborted) {
      throw nexusError('E20', 'refresh timed out', {
        reason: `no refresh completed within ${timeoutMs} ms`,
        suggestion: 'Run `nex update` in a terminal for large changes.',
        evidence: { timeoutMs, cause: mapUnknownError(error).code },
      });
    }
    throw error;
  }
}
